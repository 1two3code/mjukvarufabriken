import fp from 'fastify-plugin'
import { canTransitionLifecycle, lifecycleActionMode, lifecycleActionTarget } from '@mf/models'

import { customerSlugForOrg } from '#/lib/customerSlug.ts'
import { EntityInvalid, EntityNotFound } from '#/lib/entityError.ts'
import { provisioningJobIdOf } from '#/services/jobService.utils.ts'

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import type {
	DeployedService,
	LifecycleAction,
	LifecycleState,
	Order,
	Org,
	PreviewTeardownReport,
} from '@mf/models'
import type { DeprovisionMode, DeprovisionResult, OutcomeTally } from '@mf/org'
import type { RedeployResult } from '#/lib/expressRedeploy.ts'

/** Outcome of the onboarding account-vend step. */
export type ProvisionResult = {
	/** True when the step did nothing (flag off, or an account was already recorded). */
	skipped: boolean
	/** Why it was skipped, for the log / response. */
	reason?: string
	org: Org
	/** The vended (or reused) account id, when a vend actually ran. */
	accountId?: string
	/** True when an existing account for the slug was reused rather than created. */
	reused?: boolean
}

/** Outcome of an admin/scheduler lifecycle action. */
export type LifecycleActionResult = {
	action: LifecycleAction
	/** True for the default preview run (nothing was torn down and the state did not change). */
	dryRun: boolean
	/** The order after the action (unchanged on a dry-run). */
	order: Order
	from: LifecycleState
	to: LifecycleState
	/** True when the DB lifecycle state was actually written (a confirmed, non-idempotent move). */
	applied: boolean
	/** The @mf/org deprovision result; absent when the order has no delivery to act on. */
	deprovision?: DeprovisionResult
	/**
	 * A confirmed teardown's preview-resource cleanup (database + role, storage prefix + role) per
	 * provisioning job (wave 14). Absent for other actions and dry-runs.
	 */
	previewResources?: PreviewTeardownReport[]
}

/**
 * A confirmed teardown was asked for before the order's final export was `done` (wave 14). The
 * export is what the customer keeps of their hosting window; skipping it is an explicit admin
 * decision (`skipExport: true`), never a default.
 */
export class ExportRequired extends EntityInvalid {
	constructor(orderId: string) {
		super('export', orderId)
	}
}

declare module 'fastify' {
	interface FastifyInstance {
		/**
		 * Per-customer AWS account onboarding + delivery deprovisioning lifecycle (org-accounts.md,
		 * teardown-deprovisioning.md). Wraps the @mf/org seam (`app.org`) with the DB bookkeeping:
		 * records the vended account on the org, and drives an order's `active | suspended |
		 * torn_down` lifecycle, deprovisioning the tagged AWS resources as it goes.
		 */
		accountService: {
			/**
			 * Onboarding step: vend (or reuse) the customer's AWS account and record it on the org.
			 * Behind the `PROVISION_CUSTOMER_ACCOUNTS` flag — a no-op that records nothing until
			 * enabled, and a no-op when an account is already recorded (idempotent).
			 */
			provisionCustomerAccount: (orgId: string) => Promise<ProvisionResult>
			/**
			 * Suspend / resume / tear down an order's delivery. DRY-RUN unless `confirm: true`: a
			 * dry-run previews the deprovision and leaves the lifecycle untouched; a confirmed run
			 * deprovisions the tagged resources (fenced to the order's `Customer=<slug>`) and writes
			 * the new lifecycle state. Refuses a transition the state machine disallows (e.g. resuming
			 * a torn-down order). A confirmed `teardown` also refuses (`ExportRequired`) until the
			 * order's final export is `done` unless `skipExport` is passed, and — after the fenced
			 * deprovision succeeded and before the state flips — drops every provisioning job's
			 * preview database + role and storage prefix + role (wave 14; gated on
			 * `ORG_LIFECYCLE_ENABLED` like the deprovision itself), then writes the deletion
			 * certificate into the export.
			 */
			runLifecycleAction: (
				orderId: string,
				action: LifecycleAction,
				options?: { confirm?: boolean; label?: string; skipExport?: boolean }
			) => Promise<LifecycleActionResult>
		}
	}
}

const emptyTally = (): OutcomeTally => ({
	planned: 0,
	suspended: 0,
	resumed: 0,
	deleted: 0,
	skipped: 0,
	'already-gone': 0,
	failed: 0,
})

/**
 * The distinct `Customer=<slug>` fence tags to act on for an order: every recorded service's tag
 * (a rebuilt order accumulates a job-unique fence per build) plus the order's own slug as a
 * fallback for a delivery that predates per-service recording. This is what makes a teardown find
 * ALL of a rebuilt order's live services, not just the newest.
 */
const fenceTagsFor = (recorded: DeployedService[], order: Order): string[] => {
	const tags = new Set(recorded.map(service => service.customerTag))
	if (order.customerSlug) tags.add(order.customerSlug)
	return [...tags]
}

/** Folds several per-fence deprovision runs into one result (counts summed, entries concatenated). */
const aggregateDeprovision = (results: DeprovisionResult[]): DeprovisionResult => {
	const first = results[0]!
	if (results.length === 1) return first
	const summary = emptyTally()
	for (const result of results) {
		for (const key of Object.keys(summary) as (keyof OutcomeTally)[]) {
			summary[key] += result.summary[key]
		}
	}
	return {
		mode: first.mode,
		dryRun: first.dryRun,
		label: first.label,
		discovered: results.reduce((sum, result) => sum + result.discovered, 0),
		fenced: results.reduce((sum, result) => sum + result.fenced, 0),
		skippedByFence: results.reduce((sum, result) => sum + result.skippedByFence, 0),
		entries: results.flatMap(result => result.entries),
		summary,
	}
}

const plugin: FastifyPluginAsync = async app => {
	const { db, org, secrets, previewDbService, previewStorageService, exportService } = app

	const provisionCustomerAccount: FastifyInstance['accountService']['provisionCustomerAccount'] =
		async orgId => {
			const existing = await db.users.getOrg(orgId)
			if (!existing) throw new EntityNotFound('org', orgId)

			if (existing.awsAccountId) {
				return { skipped: true, reason: 'account already recorded', org: existing }
			}
			if (!secrets.provisionAccounts) {
				return { skipped: true, reason: 'PROVISION_CUSTOMER_ACCOUNTS is off', org: existing }
			}

			const slug = customerSlugForOrg(existing)
			const { accountId, reused } = await org.vend(slug)
			const updated = (await db.users.linkAwsAccount(orgId, { accountId, slug })) ?? existing
			app.log.info({ orgId, accountId, slug, reused }, 'Provisioned customer AWS account')
			return { skipped: false, org: updated, accountId, reused }
		}

	const runLifecycleAction: FastifyInstance['accountService']['runLifecycleAction'] = async (
		orderId,
		action,
		options
	) => {
		const order = await db.orders.getOrder(orderId)
		if (!order) throw new EntityNotFound('order', orderId)

		const from = order.lifecycle
		const to = lifecycleActionTarget[action]
		if (!canTransitionLifecycle(from, to)) throw new EntityInvalid('lifecycle', orderId)

		const dryRun = !(options?.confirm ?? false)
		const label = options?.label ?? order.name

		// The export is the customer's copy of everything the window held; a confirmed teardown
		// without one is only ever an explicit admin choice (`skipExport`), never a default.
		if (action === 'teardown' && !dryRun && !options?.skipExport) {
			const exported = await db.orderExports.get(orderId)
			if (exported?.status !== 'done') throw new ExportRequired(orderId)
		}

		// Every service this order ever delivered. A rebuild mints a new job-unique fence per build,
		// so an order accumulates services across builds; teardown/suspend act on ALL of them and
		// `resume` re-stands-up ALL of them from their recorded image/config (ECS Express has no
		// scale-to-zero, so a suspend deleted the compute — a resume must replay, not rediscover).
		const recorded = await db.deployedServices.listForOrder(orderId)
		const mode = lifecycleActionMode[action]

		const deprovision =
			mode === 'resume'
				? await resumeServices(recorded, order, dryRun)
				: await deprovisionAll(recorded, order, mode, label, dryRun)

		if (dryRun) {
			return { action, dryRun: true, order, from, to, applied: false, deprovision }
		}

		// @mf/org `deprovision` (and the redeploy) NEVER throw on a per-resource action failure: they
		// record `outcome: 'failed'`, tally it in `summary.failed`, and return normally. So a missing
		// thrown error is NOT proof the resources are gone/back — inspect the tally before advancing
		// the DB lifecycle. If any resource failed we must not record the target state (least of all
		// `torn_down`, which would strand live resources under a "gone" order). Leave the order where
		// it is — a teardown from `suspended` stays `suspended`, so the grace sweep retries it — and
		// surface the failure (the returned `deprovision.summary.failed` carries the count).
		if (deprovision && deprovision.summary.failed > 0) {
			app.log.warn(
				{ orderId, action, from, to, failed: deprovision.summary.failed },
				'Deprovision/redeploy reported resource failures — lifecycle NOT advanced'
			)
			return { action, dryRun: false, order, from, to, applied: false, deprovision }
		}

		// Teardown completeness (wave 14): the fenced deprovision only covers what @mf/org can
		// discover by tag — the Express service. The preview database/role and storage prefix/role
		// were minted by this api under deterministic names, so they are dropped here, AFTER the
		// deprovision succeeded and BEFORE the state flips: a throw leaves the order where it is
		// (the hosting sweep / grace sweep retries) rather than recording `torn_down` over live data.
		const previewResources =
			mode === 'teardown' ? await teardownPreviewResources(orderId) : undefined

		// Persist the record side-effects of a confirmed, successful action before the state flips.
		await applyRecordEffects(orderId, mode, deprovision)

		const updated = await db.orders.setLifecycle(orderId, [from], to)
		const applied = Boolean(updated) && from !== to
		app.log.info({ orderId, action, from, to, applied }, 'Lifecycle action applied')

		// The certificate is the last word of a completed teardown. Best-effort: the resources are
		// gone and the state is written — a failure here is logged for a re-run, never a rollback.
		if (mode === 'teardown' && previewResources) {
			await exportService
				.writeDeletionCertificate(orderId, {
					label,
					completedAt: new Date(),
					deprovision,
					previewResources,
					repositoryUrl: await repositoryUrlOf(orderId),
				})
				.catch((error: Error) =>
					app.log.error({ err: error, orderId }, 'Could not write the deletion certificate')
				)
		}
		return {
			action,
			dryRun: false,
			order: updated ?? order,
			from,
			to,
			applied,
			deprovision,
			...(previewResources && { previewResources }),
		}
	}

	/** The newest repository URL any of the order's jobs delivered (for the certificate) */
	const repositoryUrlOf = async (orderId: string) =>
		(await db.jobs.list({ orderId }))
			.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
			.find(job => job.repositoryUrl)?.repositoryUrl

	/**
	 * Drops the preview database + role and the storage prefix + role of EVERY provisioning job of
	 * the order (a rebuilt order has several; a redelivery maps onto its source). Every step is
	 * idempotent ("already gone" is success). Gated on the same `ORG_LIFECYCLE_ENABLED` flag as
	 * the deprovision: while it is off the whole teardown is a DB-only state change everywhere,
	 * and this half must not be the one part that actually deletes.
	 */
	const teardownPreviewResources = async (orderId: string): Promise<PreviewTeardownReport[]> => {
		const jobs = await db.jobs.list({ orderId })
		const provisioningJobIds = [...new Set(jobs.map(provisioningJobIdOf))]
		if (!secrets.orgLifecycle.enabled) {
			return provisioningJobIds.map(jobId => ({
				jobId,
				database: 'skipped',
				databaseRole: 'skipped',
				storageObjects: 'skipped',
				storageObjectCount: 0,
				storageRole: 'skipped',
				reason: 'ORG_LIFECYCLE_ENABLED is off',
			}))
		}
		const reports: PreviewTeardownReport[] = []
		for (const jobId of provisioningJobIds) {
			const database = await previewDbService.teardown(jobId)
			const storage = await previewStorageService.teardown(jobId)
			const reason = [database.reason, storage.reason].filter(Boolean).join('; ') || undefined
			reports.push({
				jobId,
				database: database.database,
				databaseRole: database.role,
				storageObjects: storage.objects,
				storageObjectCount: storage.objectCount,
				storageRole: storage.role,
				...(reason && { reason }),
			})
		}
		return reports
	}

	/** Suspend / teardown: deprovision EVERY recorded fence tag for the order, results folded into one. */
	const deprovisionAll = async (
		recorded: DeployedService[],
		order: Order,
		mode: Exclude<DeprovisionMode, 'resume'>,
		label: string,
		dryRun: boolean
	): Promise<DeprovisionResult | undefined> => {
		const tags = fenceTagsFor(recorded, order)
		if (tags.length === 0) return undefined
		const results = await Promise.all(
			tags.map(tag => org.deprovision({ customerSlug: tag, label }, mode, { dryRun }))
		)
		return aggregateDeprovision(results)
	}

	/** Resume: replay each recorded service's create config to re-stand-up the deleted Express service. */
	const resumeServices = async (
		recorded: DeployedService[],
		order: Order,
		dryRun: boolean
	): Promise<DeprovisionResult | undefined> => {
		// Nothing recorded to replay — a delivery that predates per-service recording has no config to
		// re-stand-up from, so the state flip is all this action can do (log it, don't fake a resume).
		if (recorded.length === 0) {
			if (order.customerSlug) {
				app.log.warn(
					{ orderId: order.id },
					'Resume: no recorded services to re-stand-up (delivery predates recording)'
				)
			}
			return undefined
		}
		return org.redeploy(
			recorded.map(service => ({
				id: service.id,
				serviceName: service.serviceName,
				config: service.config,
			})),
			{ dryRun }
		)
	}

	/**
	 * A confirmed action's bookkeeping on the deployed-services records: suspend nulls the arns
	 * (compute gone), teardown soft-deletes them, resume writes back the new arns from the replay.
	 */
	const applyRecordEffects = async (
		orderId: string,
		mode: DeprovisionMode,
		deprovision: DeprovisionResult | undefined
	) => {
		if (mode === 'suspend') {
			await db.deployedServices.markSuspended(orderId)
		} else if (mode === 'teardown') {
			await db.deployedServices.markTornDown(orderId)
		} else if (mode === 'resume' && deprovision && 'items' in deprovision) {
			for (const item of (deprovision as RedeployResult).items) {
				if (item.outcome === 'resumed' && item.serviceArn) {
					await db.deployedServices.setArn(item.id, item.serviceArn)
				}
			}
		}
	}

	app.decorate('accountService', { provisionCustomerAccount, runLifecycleAction })
}

export default fp(plugin, {
	name: '#internal/accountService',
	dependencies: [
		'#internal/db',
		'#internal/org',
		'#internal/secrets',
		'#internal/previewDbService',
		'#internal/previewStorageService',
		'#internal/exportService',
	],
})

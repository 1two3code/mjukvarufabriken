import { createAuditLog } from '#/audit.ts'
import { SERVICE_TAG } from '#/constants.ts'
import { DeprovisionModeSchema } from '#/schemas.ts'
import { abortError } from '#/signal.ts'

import type { ActionResult, ResourceActuator } from '#/actuator.ts'
import type { AuditLog } from '#/audit.ts'
import type { Discover } from '#/discover.ts'
import type { AuditEntry, DeliveryResource, DeprovisionMode, Outcome } from '#/schemas.ts'

/** What to deprovision: a tag-scoped fence (always ANDed with `Service=mf-delivery`) plus a label. */
export type DeprovisionTarget = {
	/** Extra tag filters passed to discovery, e.g. `{ 'mf:customer': 'acme' }`. */
	tags?: Record<string, string>
	/** Free-text label for the audit trail (a customer slug, an order id). */
	label?: string
}

export type DeprovisionOptions = {
	discover: Discover
	actuator: ResourceActuator
	/** DRY-RUN BY DEFAULT: nothing is touched unless `dryRun: false` is passed explicitly. */
	dryRun?: boolean
	/** Supply a shared audit log to append to; otherwise a fresh in-memory one is used. */
	audit?: AuditLog
	/** Service priority — resources are acted on in this order (compute first for suspend/teardown). */
	order?: string[]
	now?: () => number
	signal?: AbortSignal
}

export type OutcomeTally = Record<Outcome, number>

export type DeprovisionResult = {
	mode: DeprovisionMode
	dryRun: boolean
	label?: string
	/** Everything discovery returned. */
	discovered: number
	/** How many carried the `Service=mf-delivery` fence tag and were acted on. */
	fenced: number
	/** Discovered resources dropped for lacking the fence tag (never touched). */
	skippedByFence: number
	entries: AuditEntry[]
	summary: OutcomeTally
}

/** Compute is stopped first (cost-stop), cheap storage last; resume runs the reverse. */
const suspendTeardownOrder = ['ecs', 'apprunner', 'lambda', 'logs', 'route53', 'secretsmanager', 'ecr', 's3']
const resumeOrder = [...suspendTeardownOrder].reverse()

const emptyTally = (): OutcomeTally => ({
	planned: 0,
	suspended: 0,
	resumed: 0,
	deleted: 0,
	skipped: 0,
	'already-gone': 0,
	failed: 0,
})

const actionName: Record<DeprovisionMode, string> = {
	suspend: 'suspend',
	resume: 'resume',
	teardown: 'delete',
}

const orderer = (order: string[]) => {
	const priority = (service: string) => {
		const index = order.indexOf(service)
		return index === -1 ? order.length : index
	}
	return (a: DeliveryResource, b: DeliveryResource) =>
		priority(a.service) - priority(b.service) || a.arn.localeCompare(b.arn)
}

/**
 * Suspend / resume / teardown the tagged resources for a target.
 *
 * - **Dry-run by default** — records a `planned` audit entry per resource and touches nothing.
 * - **Tag-fenced** — only resources carrying `Service=mf-delivery` are acted on; anything else
 *   discovery returned is dropped and counted in `skippedByFence`.
 * - **Ordered** — compute is stopped before storage (cost-stop first); resume reverses it.
 * - **Idempotent & fault-tolerant** — an already-gone/half-deleted resource is reported
 *   `already-gone`, and a genuine failure is recorded and the sweep continues (never aborts midway).
 * - **Audited** — every resource touched produces one validated audit entry.
 */
export const deprovision = async (
	target: DeprovisionTarget,
	mode: DeprovisionMode,
	options: DeprovisionOptions
): Promise<DeprovisionResult> => {
	const parsedMode = DeprovisionModeSchema.parse(mode)
	const dryRun = options.dryRun ?? true
	const audit = options.audit ?? createAuditLog({ now: options.now })
	const order = options.order ?? (parsedMode === 'resume' ? resumeOrder : suspendTeardownOrder)

	const discovered = await options.discover({ tags: target.tags })
	const fenced = discovered.filter(resource => resource.tags[SERVICE_TAG.key] === SERVICE_TAG.value)
	const skippedByFence = discovered.length - fenced.length
	const ordered = [...fenced].sort(orderer(order))
	const action = actionName[parsedMode]

	for (const resource of ordered) {
		if (options.signal?.aborted) throw abortError()

		const base = { mode: parsedMode, arn: resource.arn, service: resource.service, action }

		if (dryRun) {
			audit.record({ ...base, outcome: 'planned', dryRun: true, detail: { tags: resource.tags } })
			continue
		}

		const result = await runAction(options.actuator, parsedMode, resource)
		audit.record({
			...base,
			outcome: result.outcome,
			dryRun: false,
			...(result.detail !== undefined && { detail: result.detail }),
			...(result.reason !== undefined && { reason: result.reason }),
		})
	}

	const entries = audit.entries()
	return {
		mode: parsedMode,
		dryRun,
		label: target.label,
		discovered: discovered.length,
		fenced: fenced.length,
		skippedByFence,
		entries,
		summary: tally(entries),
	}
}

type CompletedAction =
	| ActionResult
	| { outcome: 'failed'; reason: string; detail?: Record<string, unknown> }

const runAction = async (
	actuator: ResourceActuator,
	mode: DeprovisionMode,
	resource: DeliveryResource
): Promise<CompletedAction> => {
	try {
		return await actuator[mode](resource)
	} catch (error) {
		return { outcome: 'failed', reason: error instanceof Error ? error.message : String(error) }
	}
}

const tally = (entries: AuditEntry[]): OutcomeTally =>
	entries.reduce((counts, entry) => {
		counts[entry.outcome] += 1
		return counts
	}, emptyTally())

import { createHash, randomBytes } from 'node:crypto'

import fp from 'fastify-plugin'
import {
	DeliveryEventPayloadSchema,
	GateReportSchema,
	isActiveJobStatus,
	jobCostUsd,
	jobNotifyEventsMax,
	NotifyPayloadSchema,
	notifySubjectMaxLength,
	notifyTextMaxLength,
	SpecSchema,
} from '@mf/models'

import { customerSlugForBuild } from '#/lib/customerSlug.ts'
import { EntityInvalid, EntityNotFound } from '#/lib/entityError.ts'
import { defaultDownloadExpirySeconds } from '#/plugins/s3.ts'
import { deliverableFromEvents } from '#/services/jobService.utils.ts'

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import type { JobUpdate } from '@mf/db'
import type {
	BackendSession,
	DeliverablesResponse,
	GateReport,
	Job,
	JobBudget,
	JobEvent,
	JobReport,
	JobReportEvent,
	JobReportEventsResponse,
	JobReportUpdate,
	JobReportUpdateResponse,
	JobStatus,
	SizeClass,
	Spec,
} from '@mf/models'

declare module 'fastify' {
	interface FastifyInstance {
		jobService: {
			/** Starts a build for a frozen spec: inserts the job, then `ecs:RunTask` when configured */
			start: (orderId: string, session: BackendSession) => Promise<Job>
			/**
			 * Delivers the order's most recently delivered repository again — docs, deploy, live
			 * acceptance, bundle — without rebuilding (a `redeliver` job, docs/LEARNINGS.md run 7).
			 * The retry for a build whose gates passed but whose hosting side failed.
			 */
			redeliver: (orderId: string, session: BackendSession) => Promise<Job>
			/** Org-scoped read; admins see every job */
			get: (jobId: string, session: BackendSession) => Promise<Job>
			listForOrder: (orderId: string, session: BackendSession) => Promise<Job[]>
			listEvents: (jobId: string, after: number, session: BackendSession) => Promise<JobEvent[]>
			/** Admin kill switch: marks the row killed, revokes the report token, stops the task */
			kill: (jobId: string) => Promise<Job>
			/**
			 * Approve-before-deliver hold (W9): a customer or admin of the job's org releases a job
			 * parked at `awaiting_approval`, flipping `approved`. The paused build container polls its
			 * report view, sees `approved`, and resumes into delivery. Throws `JobNotAwaitingApproval`
			 * when the job is not currently holding for approval.
			 */
			approve: (jobId: string, session: BackendSession) => Promise<Job>
			/**
			 * Demo auto-retry (Gate C): an S-class job that just FAILED gets ONE automatic rebuild
			 * before a human is paged. Returns the new job, or undefined when the job is not an
			 * auto-retry candidate (not S, not failed, already retried, or itself a retry — the
			 * `retry` events on the rows bound the loop to a single attempt). Called from the
			 * container's terminal `failed` report and from the liveness sweep. When a candidate's
			 * retry cannot be created or launched, the admins are mailed before this returns or
			 * throws — the first failure's mail was held in anticipation of the retry and must
			 * never be lost.
			 */
			retryFailedBuild: (job: Job) => Promise<Job | undefined>
			listAll: () => Promise<Job[]>
			/**
			 * The delivered bundle with presigned download links (org-scoped). `EntityNotFound`
			 * until the job's `bundle` delivery step has succeeded.
			 */
			getDeliverables: (jobId: string, session: BackendSession) => Promise<DeliverablesResponse>
			/**
			 * Build-container reporting (`/internal/jobs/:jobId`, M3 hardening). The container holds
			 * only its per-job token; `authenticateReport` resolves it to the job or throws
			 * `ReportUnauthorized` (unknown or revoked token, finished job) / `EntityNotFound` (valid
			 * token, other job's url).
			 */
			authenticateReport: (jobId: string, token: string | undefined) => Promise<Job>
			/**
			 * One-shot exchange: mints a fresh token, stores its hash in place of the current one
			 * and returns it. The bootstrap token from the RunTask override (readable through the
			 * task environment, `ecs:DescribeTasks` and CloudTrail) is dead afterwards.
			 */
			rotateReportToken: (job: Job) => Promise<string>
			/** What the container needs to run: spec, budget, waivers and the kill flag */
			reportView: (job: Job) => Promise<JobReport>
			/**
			 * Stores a batch of events in order; numbered events (`seq`) are stored once. `notify`
			 * events are mailed to the admins here (capped per job), validated `gate` reports are
			 * appended to `jobs.gates`. Throws `MalformedGateReport` before storing anything.
			 */
			reportEvents: (job: Job, events: JobReportEvent[]) => Promise<JobReportEventsResponse>
			/**
			 * Status/tokens/plan/gates/urls write. Status only moves forward (`StatusRegression`
			 * otherwise); a terminal status revokes the token; the killed-guard of `db.jobs.update`
			 * keeps usage, plan and gates of a killed job but never its reason. Publishes the
			 * `JobsFailed`/`JobTokensUsed` CloudWatch metrics the ops-stack alarms read (M3
			 * hardening #2) — from this validated write, never the container's raw log lines.
			 */
			reportUpdate: (job: Job, update: JobReportUpdate) => Promise<JobReportUpdateResponse>
		}
	}
}

/** Bearer token on `/internal/jobs/*` is missing, revoked or matches no active job */
export class ReportUnauthorized extends Error {
	constructor() {
		super('Invalid job token')
	}
}

/** A `gate` event whose payload is not a `GateReport` — nothing of the batch is stored */
export class MalformedGateReport extends EntityInvalid {
	constructor(jobId: string) {
		super('gate report', jobId)
	}
}

/** A status write that would move the job backwards (e.g. `planning` after `verifying`) */
export class StatusRegression extends EntityInvalid {
	constructor(jobId: string) {
		super('job status', jobId)
	}
}

/** The spec must be frozen before a build starts */
export class SpecNotFrozen extends EntityInvalid {
	constructor(orderId: string) {
		super('spec', orderId)
	}
}

/** Only one active job per order */
export class NothingToRedeliver extends EntityInvalid {
	constructor(orderId: string) {
		super('job', orderId)
	}
}

export class JobAlreadyActive extends EntityInvalid {
	constructor(orderId: string) {
		super('job', orderId)
	}
}

/** Approve was called on a job that is not parked at the approve-before-deliver hold (W9) */
export class JobNotAwaitingApproval extends EntityInvalid {
	constructor(jobId: string) {
		super('job', jobId)
	}
}

/**
 * Hard token budget per size class: S 6M / M 15M / L 40M budget-tokens. Budget-tokens weight
 * cache reads at 10 %, and measured cost is ≈ USD 2.5 per million (demo job 2026-08-26:
 * three-task S spec, 2M spent ≈ USD 5, third task aborted), so these are ≈ USD 15 / 40 / 100
 * ceilings against 15k / 45k / 120k SEK prices.
 */
export const budgetForSize: Record<SizeClass, JobBudget> = {
	S: { maxTokens: 6_000_000, maxWorkers: 2, maxDurationMinutes: 120 },
	M: { maxTokens: 15_000_000, maxWorkers: 3, maxDurationMinutes: 240 },
	L: { maxTokens: 40_000_000, maxWorkers: 4, maxDurationMinutes: 480 },
}

/**
 * A voucher demo order (wave 14) builds on the S budget whatever its spec's size class: the
 * price is fixed at the demo tier, so the spend ceiling is too (≈ USD 15 against 500 kr).
 */
export const demoBudget: JobBudget = budgetForSize.S

/**
 * A redelivery runs no workers: only the handover prose session and the live acceptance probes
 * spend tokens. Sized well above what those cost so the cap never ends a redelivery, and well
 * below a build so a runaway one cannot cost a build.
 */
export const redeliveryBudget: JobBudget = {
	maxTokens: 3_000_000,
	maxWorkers: 1,
	maxDurationMinutes: 90,
}

/** A job whose repository is on GitHub — i.e. its delivery got past the repo step */
export const hasDeliveredRepository = (job: Job) =>
	!isActiveJobStatus(job.status) && /^https:\/\/github\.com\//.test(job.repositoryUrl ?? '')

/**
 * Which job the preview resources belong to: a redelivery reuses its SOURCE job's database,
 * storage role and Express service (deterministic names), so a retry of the hosting side never
 * mints a second set the customer's app would not be pointed at.
 */
export const provisioningJobIdOf = (job: Job) =>
	job.mode === 'redeliver' && job.sourceJobId ? job.sourceJobId : job.id

const isAdmin = (session: BackendSession) => session.role === 'admin'

// MARK: Report tokens
/** 32 random bytes, url-safe; only its hash is stored (`jobs.report_token_hash`) */
export const mintReportToken = () => randomBytes(32).toString('base64url')
export const hashReportToken = (token: string) => createHash('sha256').update(token).digest('hex')

const toDate = (value: string | undefined) => (value === undefined ? undefined : new Date(value))

/** Phases in run order; a status PATCH may repeat or advance, never go back */
const statusRank: Record<JobStatus, number> = {
	queued: 0,
	planning: 1,
	building: 2,
	verifying: 3,
	delivered: 4,
	failed: 4,
	killed: 4,
}

/**
 * URLs the delivery decided to withhold from the customer: a `delivery` event stream where a
 * URL's LAST `acceptance` step failed means the platform judged the live app at that URL broken
 * and nulled it on the deliverable — but the earlier `deploy` step event (emitted before the
 * verdict existed) and the failed `acceptance` event itself still carry it. Served unredacted,
 * the customer's event stream would hand out a "working" URL the platform just withheld.
 */
const withheldDeployUrls = (events: JobEvent[]): Set<string> => {
	const lastVerdictByUrl = new Map<string, boolean>()
	for (const event of events) {
		if (event.type !== 'delivery') continue
		const { step, ok, url } = event.payload
		if (step === 'acceptance' && typeof url === 'string') lastVerdictByUrl.set(url, ok === true)
	}
	return new Set([...lastVerdictByUrl].filter(([, passed]) => !passed).map(([url]) => url))
}

/**
 * What a customer may see of the event log: `notify` events are addressed to the admins and
 * `gate` details carry the full review findings / test output of the delivered code — both stay
 * admin-only. Customers get the gate's name, verdict, timing, tokens and one-line summary.
 * Delivery events lose their `url` when the live acceptance check withheld that URL as broken
 * ({@link withheldDeployUrls}) — the deliverable already nulls `deployUrl`; this closes the same
 * promise on the customer-readable event stream — and when it is an artifacts-bucket object
 * (the `bundle` step, a failed `deploy`): those are served presigned by the deliverables route.
 */
export const redactEventsForCustomer = (events: JobEvent[]): JobEvent[] => {
	const withheld = withheldDeployUrls(events)
	return events
		.filter(event => event.type !== 'notify')
		.map(event => {
			if (event.type === 'delivery' && typeof event.payload.url === 'string') {
				const { step, ok, url } = event.payload
				// Artifacts-bucket objects (the bundle; the static-site fallback a failed deploy
				// points at) are BLOCK_ALL and reached only through the presigned links of
				// GET /jobs/:id/deliverables — the bucket name, region and key layout stay internal.
				// (A failed `acceptance` carries the LIVE url; {@link withheldDeployUrls} judges it.)
				const bucketObject = step === 'bundle' || (step === 'deploy' && ok !== true)
				if (bucketObject || withheld.has(url)) {
					const { url: _url, ...payload } = event.payload
					return { ...event, payload }
				}
			}
			if (event.type !== 'gate') return event
			const { details: _details, ...payload } = event.payload
			return { ...event, payload }
		})
}

/**
 * The same rule for a job row's stored gate reports: `gates[].details` carry the review findings
 * and test output of the delivered code, so a customer sees only each gate's name, verdict,
 * timing, tokens and one-line summary. Admins get the row unchanged.
 */
export const redactJobForCustomer = (job: Job): Job =>
	job.gates ? { ...job, gates: job.gates.map(({ details: _details, ...gate }) => gate) } : job

/** The delivery record parser lives in `jobService.utils.ts` (shared with the showcase gallery) */
export { deliverableFromEvents }

/** Notify text is built from raw worker output; cut it to the schema caps rather than drop the mail */
const truncateNotifyPayload = (payload: Record<string, unknown>) => ({
	...payload,
	subject:
		typeof payload.subject === 'string'
			? payload.subject.slice(0, notifySubjectMaxLength)
			: payload.subject,
	text:
		typeof payload.text === 'string' ? payload.text.slice(0, notifyTextMaxLength) : payload.text,
})

/** Fields of a refused (killed) update that may still land on the row */
const keepOnKilledRow = ({ tokensUsed, usage, costUsd, plan, gates }: JobUpdate): JobUpdate => ({
	...(tokensUsed !== undefined && { tokensUsed }),
	...(usage !== undefined && { usage }),
	...(costUsd !== undefined && { costUsd }),
	...(plan !== undefined && { plan }),
	...(gates !== undefined && { gates }),
})

const plugin: FastifyPluginAsync = async app => {
	const { db, ecs, metrics, s3, specService } = app

	/** The model prices the job bills at: those in effect at its order's creation (else now) */
	const pricesForJob = async (job: Job) => {
		const order = await db.orders.getOrder(job.orderId)
		return db.modelPrices.effectiveAt(order ? new Date(order.createdAt) : new Date())
	}

	/**
	 * The order creator's GitHub login as of their latest GitHub sign-in (M6) — resolved from the
	 * user on every read (never a snapshot: logins are renamed and freed, and a customer may sign
	 * in with GitHub only after ordering). M5 delivery adds this login as admin on the repo.
	 */
	const customerGithubLoginOf = async (job: Job) => {
		const order = await db.orders.getOrder(job.orderId)
		const user = order?.createdBy ? await db.users.get(order.createdBy) : undefined
		return user?.githubLogin
	}

	/**
	 * What a `redeliver` job delivers again: the source job's repository, plus its plan and gate
	 * reports (the handover docs are written from them). Undefined for a build.
	 */
	const redeliverySourceOf = async (job: Job) => {
		if (job.mode !== 'redeliver' || !job.sourceJobId) return undefined
		const source = await db.jobs.get(job.sourceJobId)
		if (!source?.repositoryUrl) return undefined
		return {
			jobId: source.id,
			repositoryUrl: source.repositoryUrl,
			plan: source.plan,
			gates: source.gates,
		}
	}

	/** The approve-before-deliver flag lives on the order (W9); the job reads it via its report view */
	const approveBeforeDeliverOf = async (job: Job) =>
		(await db.orders.getOrder(job.orderId))?.approveBeforeDeliver ?? false

	/**
	 * The budget a build of this order gets: its size class's, except a voucher demo (wave 14)
	 * always runs on the S budget — the customer paid ~500 kr whatever the classifier said, so
	 * the class sizes nothing but the spend ceiling, and that ceiling is the demo's.
	 */
	const budgetFor = async (orderId: string, spec: Spec): Promise<JobBudget> => {
		const order = await db.orders.getOrder(orderId)
		return order?.kind === 'demo' ? demoBudget : budgetForSize[spec.sizeClass ?? 'S']
	}

	const scoped = (job: Job | undefined, session: BackendSession, id: string) => {
		if (!job || (!isAdmin(session) && job.orgId !== session.orgId)) {
			throw new EntityNotFound('job', id)
		}
		return job
	}

	const get: FastifyInstance['jobService']['get'] = async (jobId, session) => {
		const job = scoped(await db.jobs.get(jobId), session, jobId)
		return isAdmin(session) ? job : redactJobForCustomer(job)
	}

	/**
	 * Forwards a `notify` event to every admin; a mail failure never fails the report. Capped
	 * per job: the token lives in a container running customer-driven code.
	 */
	const notifyAdmins = async (job: Job, event: JobReportEvent) => {
		const parsed = NotifyPayloadSchema.safeParse(truncateNotifyPayload(event.payload))
		if (!parsed.success) {
			app.log.warn({ jobId: job.id, issues: parsed.error.issues }, 'Malformed notify event')
			return
		}
		const sent = await db.jobs.countEvents(job.id, 'notify')
		if (sent > jobNotifyEventsMax) {
			app.log.warn({ jobId: job.id, sent }, 'Notify cap reached — not mailing the admins')
			return
		}
		const { subject, text } = parsed.data
		for (const to of app.secrets.authAdminEmails) {
			await app.email
				.send({ to, subject: `[mf ${app.secrets.env}] ${subject}`, text })
				.catch(error => {
					app.log.error({ err: error, jobId: job.id, to }, 'Could not send the job notification')
				})
		}
	}

	/**
	 * Demo auto-retry candidacy (Gate C; strategy 2026-08-31 #4). Only the S/demo class retries —
	 * a rebuild costs ~100 kr — and only ONCE: a job that already spawned a retry carries a
	 * `retry` event ({retryJobId}), a job that IS a retry carries one too ({ofJobId}), and either
	 * disqualifies it, so two failed attempts can never chain into a third. The bound is
	 * structural: `db.jobs.insertRetry` writes the retry row and BOTH events in one transaction,
	 * so no crash can leave a retry row that reads as a fresh first attempt.
	 *
	 * The class is the ORDER's rung first (a voucher demo retries whatever its spec was classified
	 * as — it runs on the S budget anyway, see `budgetFor`), then the spec's size class.
	 */
	const autoRetryCandidate = async (job: Job) => {
		const order = await db.orders.getOrder(job.orderId)
		if (order?.kind !== 'demo' && (job.spec.sizeClass ?? 'S') !== 'S') return false
		const events = await db.jobs.listEvents(job.id)
		return !events.some(event => event.type === 'retry')
	}

	/**
	 * The compensating page for a held first-failure mail (see `reportEvents`): sent whenever the
	 * retry that justified the hold could NOT be started, so a failed demo build can never
	 * disappear with only a log line. Mails directly — no notify-cap lookup: this path runs
	 * exactly when the db may be misbehaving, and the text is api-composed, not container input.
	 */
	const sendHeldFailureMail = async (job: Job, why: string) => {
		const subject = `[mf ${app.secrets.env}] Build job ${job.id} failed — auto-retry not started`
		const text = `Job ${job.id} (order ${job.orderId}) failed:\n${job.reason ?? '-'}\n\nIts automatic retry was NOT started: ${why}\n\nThe first-failure notification was held in anticipation of the retry; this mail replaces it.`
		for (const to of app.secrets.authAdminEmails) {
			await app.email.send({ to, subject, text }).catch(error => {
				app.log.error({ err: error, jobId: job.id, to }, 'Could not send the held failure mail')
			})
		}
	}

	/**
	 * Launches the one automatic rebuild of a failed S-class job: a fresh job row for the same
	 * order/spec with the standard S budget (each attempt keeps its own token/cost accounting;
	 * the order's total is the sum over its jobs), inserted atomically with the `retry` events
	 * that link both rows (`db.jobs.insertRetry`). If the retry cannot be created or launched,
	 * the admins are mailed — their first-failure notification was held in anticipation of it.
	 */
	const retryFailedBuild = async (job: Job): Promise<Job | undefined> => {
		if (job.status !== 'failed' || !(await autoRetryCandidate(job))) return undefined
		const reportToken = mintReportToken()
		let retry: Job
		try {
			retry = await db.jobs.insertRetry(
				{
					orderId: job.orderId,
					orgId: job.orgId,
					spec: job.spec,
					// The failed attempt's own budget: S for an S spec and for a demo of any class
					budget: job.budget,
					reportTokenHash: hashReportToken(reportToken),
				},
				{ id: job.id, reason: job.reason, tokensUsed: job.tokensUsed }
			)
		} catch (error) {
			if ((error as Error & { code?: string }).code === '23505') {
				// One-active-job-per-order: another writer got there first. A concurrent retry of
				// THIS job committed its `retry` event with its row — then a rebuild is running and
				// the held mail stays held. Any OTHER active job (a human re-ordered a build) means
				// no retry will ever page for this failure: send the held mail now. A failing
				// re-read fails open towards mailing (a duplicate page beats silence).
				const events = await db.jobs.listEvents(job.id).catch(() => [])
				if (!events.some(event => event.type === 'retry')) {
					await sendHeldFailureMail(job, 'another job is already active for the order')
				}
				return undefined
			}
			// The held first-failure mail must not die with the insert (db blip): page now, then
			// rethrow for the caller's log line
			await sendHeldFailureMail(
				job,
				`the retry job could not be created: ${(error as Error).message}`
			)
			throw error
		}
		app.log.warn(
			{ jobId: job.id, retryJobId: retry.id, reason: job.reason },
			'S-class build failed — auto-retrying once before paging anyone'
		)
		// The deprovision fence must point at the attempt that will actually DELIVER: delivery
		// stamps the live resources with a tag derived from the retry's OWN job id, so re-record
		// the order's customer slug for it (mirrors `start`; best-effort, never fails the retry).
		await db.orders
			.setCustomerSlug(job.orderId, customerSlugForBuild(retry.spec.goal, retry.id))
			.catch((error: Error) =>
				app.log.warn({ err: error, jobId: retry.id }, 'Could not record the order customer slug')
			)
		if (!ecs.configured) {
			app.log.warn({ jobId: retry.id }, `ECS not configured — run: npm run job:dev -- ${retry.id}`)
			return retry
		}
		try {
			const taskArn = await ecs.runJob(retry.id, reportToken)
			return (await db.jobs.update(retry.id, { taskArn })) ?? retry
		} catch (error) {
			const reason = `ecs:RunTask failed on the auto-retry: ${(error as Error).message}`
			app.log.error({ err: error, jobId: retry.id }, reason)
			await db.jobs.appendEvent(retry.id, { type: 'failed', payload: { reason } })
			const failed = await db.jobs.update(retry.id, {
				status: 'failed',
				reason,
				finishedAt: new Date(),
				reportTokenHash: null,
			})
			await notifyAdmins(retry, {
				type: 'notify',
				payload: {
					to: 'admins',
					subject: `Build job ${job.id} failed and its auto-retry could not launch`,
					text: `Job ${job.id} failed:\n${job.reason ?? '-'}\n\nThe automatic retry ${retry.id} could not be started:\n${reason}`,
				},
			})
			return failed ?? retry
		}
	}

	/** Every `gate` payload must be a GateReport — `jobs.gates` is typed and serialised as such */
	const parseGateReports = (job: Job, events: JobReportEvent[]) => {
		const gates = new Map<JobReportEvent, GateReport>()
		for (const event of events) {
			if (event.type !== 'gate') continue
			const parsed = GateReportSchema.safeParse(event.payload)
			if (!parsed.success) {
				app.log.warn({ jobId: job.id, issues: parsed.error.issues }, 'Malformed gate report')
				throw new MalformedGateReport(job.id)
			}
			gates.set(event, parsed.data)
		}
		return gates
	}

	const storeEvent = async (jobId: string, { seq, ...event }: JobReportEvent) =>
		seq === undefined
			? { event: await db.jobs.appendEvent(jobId, event), duplicate: false }
			: db.jobs.appendEventOnce(jobId, seq, event)

	/**
	 * Records the Express service a delivery stood up against the order (wave 10,
	 * delivery-lifecycle-followups). The final `bundle` delivery event carries the deliverable's
	 * `deployedService` whenever a service was actually created — including a delivery whose
	 * post-deploy acceptance check failed (Gate C): its `deployUrl` is withheld (null) but the
	 * service exists and MUST be teardownable, so presence of `deployedService`, not the URL, is
	 * what triggers recording. Recording it lets the admin teardown target EVERY recorded
	 * service of a rebuilt order and lets `resume` replay the image/config to re-create a
	 * suspended (deleted) one. Best-effort: a failure here never fails the container's report
	 * (the deploy already succeeded).
	 */
	const recordDeployedService = async (job: Job, event: JobReportEvent) => {
		if (event.type !== 'delivery') return
		const parsed = DeliveryEventPayloadSchema.safeParse(event.payload)
		const deliverable = parsed.success ? parsed.data.deliverable : undefined
		const service = deliverable?.deployedService
		if (!deliverable || !service) return
		await db.deployedServices
			.record({
				orderId: job.orderId,
				jobId: job.id,
				serviceName: service.serviceName,
				serviceArn: service.serviceArn ?? null,
				customerTag: service.customerTag,
				image: service.image ?? null,
				config: service.config ?? null,
			})
			.catch((error: Error) =>
				app.log.warn(
					{ err: error, jobId: job.id, service: service.serviceName },
					'Could not record the deployed service for teardown/resume'
				)
			)
	}

	/** `ecs:RunTask` for an inserted row, or a terminal `failed` row when the launch itself fails */
	const launch = async (job: Job, reportToken: string): Promise<Job> => {
		if (!ecs.configured) {
			app.log.warn({ jobId: job.id }, `ECS not configured — run: npm run job:dev -- ${job.id}`)
			return job
		}
		try {
			const taskArn = await ecs.runJob(job.id, reportToken)
			return (await db.jobs.update(job.id, { taskArn })) ?? job
		} catch (error) {
			const reason = `ecs:RunTask failed: ${(error as Error).message}`
			app.log.error({ err: error, jobId: job.id }, reason)
			await db.jobs.appendEvent(job.id, { type: 'failed', payload: { reason } })
			return (
				(await db.jobs.update(job.id, {
					status: 'failed',
					reason,
					finishedAt: new Date(),
					reportTokenHash: null,
				})) ?? job
			)
		}
	}

	app.decorate('jobService', {
		get,
		start: async (orderId, session) => {
			// Org-scoped via the order: specService.get is EntityNotFound for another org's draft
			const draft = await specService.get(orderId, session)
			if (draft.status !== 'frozen') throw new SpecNotFrozen(orderId)
			const spec = SpecSchema.parse(draft.spec)
			const orgId = draft.orgId ?? session.orgId

			// Friendly fast path; the jobs_one_active_per_order index is the real guard (23505)
			const existing = await db.jobs.list({ orderId })
			if (existing.some(job => isActiveJobStatus(job.status))) throw new JobAlreadyActive(orderId)

			const reportToken = mintReportToken()
			const job = await db.jobs
				.insert({
					orderId,
					orgId,
					spec,
					budget: await budgetFor(orderId, spec),
					reportTokenHash: hashReportToken(reportToken),
				})
				.catch((error: Error & { code?: string }) => {
					if (error.code === '23505') throw new JobAlreadyActive(orderId)
					throw error
				})

			// Record the per-customer fence slug delivery will stamp on this build's ECS Express
			// service (`Customer=<slug>`), so the admin deprovisioning lifecycle can later scope a
			// suspend/teardown to exactly this order's resources. Best-effort — never fail a build over it.
			await db.orders
				.setCustomerSlug(orderId, customerSlugForBuild(spec.goal, job.id))
				.catch((error: Error) =>
					app.log.warn({ err: error, jobId: job.id }, 'Could not record the order customer slug')
				)

			return launch(job, reportToken)
		},
		redeliver: async (orderId, session) => {
			// Org-scoped the same way `start` is: the spec draft is EntityNotFound for another org
			const draft = await specService.get(orderId, session)
			const orgId = draft.orgId ?? session.orgId
			const jobs = await db.jobs.list({ orderId })
			if (jobs.some(job => isActiveJobStatus(job.status))) throw new JobAlreadyActive(orderId)
			// The newest job that got its repository onto GitHub — a build, or an earlier redelivery
			// (whose source is then carried forward, so the chain always points at the build)
			const latest = jobs
				.filter(hasDeliveredRepository)
				.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
			if (!latest) throw new NothingToRedeliver(orderId)
			const sourceJobId = provisioningJobIdOf(latest)
			const source = latest.id === sourceJobId ? latest : await db.jobs.get(sourceJobId)
			if (!source) throw new NothingToRedeliver(orderId)

			const reportToken = mintReportToken()
			const job = await db.jobs
				.insert({
					orderId,
					orgId,
					spec: source.spec,
					budget: redeliveryBudget,
					mode: 'redeliver',
					sourceJobId: source.id,
					reportTokenHash: hashReportToken(reportToken),
				})
				.catch((error: Error & { code?: string }) => {
					if (error.code === '23505') throw new JobAlreadyActive(orderId)
					throw error
				})
			return launch(job, reportToken)
		},
		listForOrder: async (orderId, session) => {
			const jobs = await db.jobs.list({ orderId })
			if (isAdmin(session)) return jobs
			return jobs.filter(job => job.orgId === session.orgId).map(redactJobForCustomer)
		},
		listEvents: async (jobId, after, session) => {
			await get(jobId, session)
			const events = await db.jobs.listEvents(jobId, after)
			return isAdmin(session) ? events : redactEventsForCustomer(events)
		},
		kill: async jobId => {
			const job = await db.jobs.get(jobId)
			if (!job) throw new EntityNotFound('job', jobId)
			if (!isActiveJobStatus(job.status)) return job

			// The token dies with the job: whatever the container still sends is refused (401)
			const reason = 'killed by admin'
			const killed =
				(await db.jobs.update(jobId, {
					status: 'killed',
					reason,
					finishedAt: new Date(),
					reportTokenHash: null,
				})) ?? job
			await db.jobs.appendEvent(jobId, { type: 'killed', payload: { reason } })
			if (job.taskArn) {
				await ecs.stopTask(job.taskArn, reason).catch(error => {
					app.log.warn(
						{ err: error, jobId },
						'ecs:StopTask failed — the job polls its row and aborts itself'
					)
				})
			}
			return killed
		},
		approve: async (jobId, session) => {
			const job = scoped(await db.jobs.get(jobId), session, jobId)
			// The hold is real only while the container is parked there: an active job that reported
			// `awaiting_approval` and has not been approved yet. Anything else (already delivering,
			// already approved, finished, or never gated) is a no-op the caller should see as 409.
			if (!job.awaitingApproval || job.approved || !isActiveJobStatus(job.status)) {
				throw new JobNotAwaitingApproval(jobId)
			}
			const approved = (await db.jobs.update(jobId, { approved: true })) ?? job
			return isAdmin(session) ? approved : redactJobForCustomer(approved)
		},
		retryFailedBuild,
		listAll: () => db.jobs.list(),
		getDeliverables: async (jobId, session) => {
			await get(jobId, session)
			const deliverable = deliverableFromEvents(await db.jobs.listEvents(jobId))
			if (!deliverable) throw new EntityNotFound('deliverables', jobId)
			const expiresAt = new Date(Date.now() + defaultDownloadExpirySeconds * 1000).toISOString()
			const files = await Promise.all(
				deliverable.files.map(async file => ({
					...file,
					url: await s3.presignDownload(file.key, defaultDownloadExpirySeconds),
					expiresAt,
				}))
			)
			return { ...deliverable, files }
		},

		authenticateReport: async (jobId, token) => {
			const job = token ? await db.jobs.getByReportToken(hashReportToken(token)) : undefined
			// A finished job's token is worthless even if a row still carries the hash
			if (!job || !isActiveJobStatus(job.status)) throw new ReportUnauthorized()
			if (job.id !== jobId) throw new EntityNotFound('job', jobId)
			return job
		},
		rotateReportToken: async job => {
			const token = mintReportToken()
			await db.jobs.update(job.id, { reportTokenHash: hashReportToken(token) })
			return token
		},
		reportView: async job => ({
			id: job.id,
			status: job.status,
			spec: job.spec,
			budget: job.budget,
			gateWaivers: job.gateWaivers,
			killed: job.status === 'killed',
			customerGithubLogin: await customerGithubLoginOf(job),
			approveBeforeDeliver: await approveBeforeDeliverOf(job),
			approved: job.approved ?? false,
			mode: job.mode ?? 'build',
			source: await redeliverySourceOf(job),
		}),
		reportEvents: async (job, events) => {
			const gateReports = parseGateReports(job, events)
			let lastEventId = 0
			const gates: GateReport[] = []
			for (const event of events) {
				const { event: stored, duplicate } = await storeEvent(job.id, event)
				lastEventId = stored.id
				if (duplicate) continue
				const gate = gateReports.get(event)
				if (gate) gates.push(gate)
				if (event.type === 'notify') {
					// Hold the build-failure mail (only that mail — deploy degradations etc. still
					// page) for a job the auto-retry will rebuild: the human is paged when the
					// SECOND attempt fails, whose own job is no candidate. The event itself is
					// stored either way, so the trail keeps the first failure. The hold is safe
					// because every way the retry can then fail to happen pages instead:
					// `retryFailedBuild` mails when it cannot create/launch the retry, and the
					// liveness sweep mails for any job that dies without reporting.
					if (event.payload.kind === 'job-failed' && (await autoRetryCandidate(job))) {
						app.log.warn(
							{ jobId: job.id },
							'Holding the failure mail — the build will be auto-retried'
						)
					} else {
						await notifyAdmins(job, event)
					}
				}
				if (event.type === 'delivery') await recordDeployedService(job, event)
			}
			if (gates.length) {
				const current = (await db.jobs.get(job.id))?.gates ?? []
				await db.jobs.update(job.id, { gates: [...current, ...gates] })
			}
			return { lastEventId }
		},
		reportUpdate: async (job, update) => {
			const { status } = update
			if (status && statusRank[status] < statusRank[job.status]) throw new StatusRegression(job.id)
			const terminal = status !== undefined && !isActiveJobStatus(status)
			const write: JobUpdate = {
				...update,
				// Raw usage is priced at the model prices in effect when the ORDER was created, so a
				// later price change never reprices an order already placed (migration 0018).
				...(update.usage && { costUsd: jobCostUsd(update.usage, await pricesForJob(job)) }),
				startedAt: toDate(update.startedAt),
				finishedAt: toDate(update.finishedAt),
				// The last write of the job: nothing holding this token has anything left to say
				...(terminal && { reportTokenHash: null }),
			}
			const row = await db.jobs.update(job.id, write)
			// Tamper-proof alarm metrics (M3 hardening #2): this write already passed the
			// forward-only status check and Zod validation, so — unlike the container's raw log
			// lines a customer build script can also print — a spoofed spike or a hidden failure
			// isn't possible here.
			if (update.tokensUsed !== undefined) {
				await metrics.recordJobTokensUsed(job.id, update.tokensUsed)
			}
			if (row) {
				if (row.status === 'failed') {
					await metrics.recordJobFailed(job.id)
					// The terminal failure is the auto-retry trigger; a retry hiccup must never
					// fail the container's last report (the row is already terminal either way)
					await retryFailedBuild(row).catch((error: Error) =>
						app.log.error({ err: error, jobId: job.id }, 'Auto-retry of the failed build threw')
					)
				}
				return { status: row.status, killed: row.status === 'killed' }
			}
			// Status write refused: the admin killed the job. Usage, plan and gates still land;
			// the reason and the timestamps of the kill stay as the admin wrote them.
			const rest = keepOnKilledRow(write)
			if (Object.keys(rest).length) await db.jobs.update(job.id, rest)
			return { status: 'killed', killed: true }
		},
	})
}

export default fp(plugin, {
	name: '#internal/jobService',
	dependencies: [
		'#internal/db',
		'#internal/ecs',
		'#internal/email',
		'#internal/metrics',
		'#internal/s3',
		'#internal/specService',
	],
})

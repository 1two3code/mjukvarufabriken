import { createHash, randomBytes } from 'node:crypto'

import fp from 'fastify-plugin'
import {
	DeliveryEventPayloadSchema,
	GateReportSchema,
	isActiveJobStatus,
	jobNotifyEventsMax,
	NotifyPayloadSchema,
	notifySubjectMaxLength,
	notifyTextMaxLength,
	SpecSchema,
} from '@mf/models'

import { customerSlugForBuild } from '#/lib/customerSlug.ts'
import { EntityInvalid, EntityNotFound } from '#/lib/entityError.ts'
import { defaultDownloadExpirySeconds } from '#/plugins/s3.ts'

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import type { JobUpdate } from '@mf/db'
import type {
	BackendSession,
	Deliverable,
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
} from '@mf/models'

declare module 'fastify' {
	interface FastifyInstance {
		jobService: {
			/** Starts a build for a frozen spec: inserts the job, then `ecs:RunTask` when configured */
			start: (orderId: string, session: BackendSession) => Promise<Job>
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
			 * keeps usage, plan and gates of a killed job but never its reason
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
 * What a customer may see of the event log: `notify` events are addressed to the admins and
 * `gate` details carry the full review findings / test output of the delivered code — both stay
 * admin-only. Customers get the gate's name, verdict, timing, tokens and one-line summary.
 */
export const redactEventsForCustomer = (events: JobEvent[]): JobEvent[] =>
	events
		.filter(event => event.type !== 'notify')
		.map(event => {
			if (event.type !== 'gate') return event
			const { details: _details, ...payload } = event.payload
			return { ...event, payload }
		})

/**
 * The same rule for a job row's stored gate reports: `gates[].details` carry the review findings
 * and test output of the delivered code, so a customer sees only each gate's name, verdict,
 * timing, tokens and one-line summary. Admins get the row unchanged.
 */
export const redactJobForCustomer = (job: Job): Job =>
	job.gates
		? { ...job, gates: job.gates.map(({ details: _details, ...gate }) => gate) }
		: job

/**
 * The delivery record lives in the last successful `bundle` delivery event (the job writes
 * events only; no job column for it). Undefined until the job delivered.
 */
export const deliverableFromEvents = (events: JobEvent[]): Deliverable | undefined => {
	for (const event of events.toReversed()) {
		if (event.type !== 'delivery') continue
		const parsed = DeliveryEventPayloadSchema.safeParse(event.payload)
		if (
			parsed.success &&
			parsed.data.step === 'bundle' &&
			parsed.data.ok &&
			parsed.data.deliverable
		) {
			return parsed.data.deliverable
		}
	}
	return undefined
}

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
const keepOnKilledRow = ({ tokensUsed, plan, gates }: JobReportUpdate): JobUpdate => ({
	...(tokensUsed !== undefined && { tokensUsed }),
	...(plan !== undefined && { plan }),
	...(gates !== undefined && { gates }),
})

const plugin: FastifyPluginAsync = async app => {
	const { db, ecs, s3, specService } = app

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

	/** The approve-before-deliver flag lives on the order (W9); the job reads it via its report view */
	const approveBeforeDeliverOf = async (job: Job) =>
		(await db.orders.getOrder(job.orderId))?.approveBeforeDeliver ?? false

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
	 * `deployedService` when a service was actually created (`deployUrl` non-null). Recording it
	 * lets the admin teardown target EVERY recorded service of a rebuilt order and lets `resume`
	 * replay the image/config to re-create a suspended (deleted) one. Best-effort: a failure here
	 * never fails the container's report (the deploy already succeeded).
	 */
	const recordDeployedService = async (job: Job, event: JobReportEvent) => {
		if (event.type !== 'delivery') return
		const parsed = DeliveryEventPayloadSchema.safeParse(event.payload)
		const deliverable = parsed.success ? parsed.data.deliverable : undefined
		const service = deliverable?.deployedService
		if (!deliverable || deliverable.deployUrl === null || !service) return
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

	app.decorate('jobService', {
		get,
		start: async (orderId, session) => {
			// Org-scoped via the order: specService.get is EntityNotFound for another org's draft
			const draft = await specService.get(orderId, session)
			if (draft.status !== 'frozen') throw new SpecNotFrozen(orderId)
			const spec = SpecSchema.parse(draft.spec)
			const sizeClass = spec.sizeClass ?? 'S'
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
					budget: budgetForSize[sizeClass],
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
				if (event.type === 'notify') await notifyAdmins(job, event)
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
			const row = await db.jobs.update(job.id, {
				...update,
				startedAt: toDate(update.startedAt),
				finishedAt: toDate(update.finishedAt),
				// The last write of the job: nothing holding this token has anything left to say
				...(terminal && { reportTokenHash: null }),
			})
			if (row) return { status: row.status, killed: row.status === 'killed' }
			// Status write refused: the admin killed the job. Usage, plan and gates still land;
			// the reason and the timestamps of the kill stay as the admin wrote them.
			const rest = keepOnKilledRow(update)
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
		'#internal/s3',
		'#internal/specService',
	],
})

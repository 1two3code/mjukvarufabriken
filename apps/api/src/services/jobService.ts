import { createHash, randomBytes } from 'node:crypto'

import fp from 'fastify-plugin'
import { isActiveJobStatus, NotifyPayloadSchema, SpecSchema } from '@mf/models'

import { EntityInvalid, EntityNotFound } from '#/lib/entityError.ts'

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import type {
	BackendSession,
	GateReport,
	Job,
	JobBudget,
	JobEvent,
	JobReport,
	JobReportEventsResponse,
	JobReportUpdate,
	JobReportUpdateResponse,
	NewJobEvent,
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
			/** Admin kill switch: marks the row killed and stops the Fargate task */
			kill: (jobId: string) => Promise<Job>
			listAll: () => Promise<Job[]>
			/**
			 * Build-container reporting (`/internal/jobs/:jobId`, M3 hardening). The container holds
			 * only its per-job token; `authenticateReport` resolves it to the job or throws
			 * `ReportUnauthorized` (unknown token) / `EntityNotFound` (valid token, other job's url).
			 */
			authenticateReport: (jobId: string, token: string | undefined) => Promise<Job>
			/** What the container needs to run: spec, budget, waivers and the kill flag */
			reportView: (job: Job) => JobReport
			/**
			 * Stores a batch of events in order. `notify` events are mailed to the admins here (the
			 * container has no email access), `gate` reports are appended to `jobs.gates`.
			 */
			reportEvents: (job: Job, events: NewJobEvent[]) => Promise<JobReportEventsResponse>
			/** Status/tokens/plan/gates/urls write with the killed-guard of `db.jobs.update` */
			reportUpdate: (job: Job, update: JobReportUpdate) => Promise<JobReportUpdateResponse>
		}
	}
}

/** Bearer token on `/internal/jobs/*` is missing or matches no job */
export class ReportUnauthorized extends Error {
	constructor() {
		super('Invalid job token')
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

const plugin: FastifyPluginAsync = async app => {
	const { db, ecs, specService } = app

	const scoped = (job: Job | undefined, session: BackendSession, id: string) => {
		if (!job || (!isAdmin(session) && job.orgId !== session.orgId)) {
			throw new EntityNotFound('job', id)
		}
		return job
	}

	const get: FastifyInstance['jobService']['get'] = async (jobId, session) =>
		scoped(await db.jobs.get(jobId), session, jobId)

	/** Forwards a `notify` event to every admin; a mail failure never fails the report */
	const notifyAdmins = async (job: Job, event: NewJobEvent) => {
		const parsed = NotifyPayloadSchema.safeParse(event.payload)
		if (!parsed.success) {
			app.log.warn({ jobId: job.id, issues: parsed.error.issues }, 'Malformed notify event')
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
					(await db.jobs.update(job.id, { status: 'failed', reason, finishedAt: new Date() })) ??
					job
				)
			}
		},
		listForOrder: async (orderId, session) => {
			const jobs = await db.jobs.list({ orderId })
			return isAdmin(session) ? jobs : jobs.filter(job => job.orgId === session.orgId)
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

			const reason = 'killed by admin'
			const killed =
				(await db.jobs.update(jobId, { status: 'killed', reason, finishedAt: new Date() })) ?? job
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
		listAll: () => db.jobs.list(),

		authenticateReport: async (jobId, token) => {
			const job = token ? await db.jobs.getByReportToken(hashReportToken(token)) : undefined
			if (!job) throw new ReportUnauthorized()
			if (job.id !== jobId) throw new EntityNotFound('job', jobId)
			return job
		},
		reportView: job => ({
			id: job.id,
			status: job.status,
			spec: job.spec,
			budget: job.budget,
			gateWaivers: job.gateWaivers,
			killed: job.status === 'killed',
		}),
		reportEvents: async (job, events) => {
			let lastEventId = 0
			const gates: GateReport[] = []
			for (const event of events) {
				const stored = await db.jobs.appendEvent(job.id, event)
				lastEventId = stored.id
				if (event.type === 'gate') gates.push(event.payload as GateReport)
				if (event.type === 'notify') await notifyAdmins(job, event)
			}
			if (gates.length) {
				const current = (await db.jobs.get(job.id))?.gates ?? []
				await db.jobs.update(job.id, { gates: [...current, ...gates] })
			}
			return { lastEventId }
		},
		reportUpdate: async (job, update) => {
			const row = await db.jobs.update(job.id, {
				...update,
				startedAt: toDate(update.startedAt),
				finishedAt: toDate(update.finishedAt),
			})
			if (row) return { status: row.status, killed: row.status === 'killed' }
			// Status write refused: the admin killed the job. Usage, plan and gates still land.
			const { status: _status, ...rest } = update
			if (Object.keys(rest).length) {
				await db.jobs.update(job.id, {
					...rest,
					startedAt: toDate(rest.startedAt),
					finishedAt: toDate(rest.finishedAt),
				})
			}
			return { status: 'killed', killed: true }
		},
	})
}

export default fp(plugin, {
	name: '#internal/jobService',
	dependencies: ['#internal/db', '#internal/ecs', '#internal/email', '#internal/specService'],
})

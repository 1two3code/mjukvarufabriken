import { activeJobStatus } from '@mf/models'

import type {
	GateReport,
	Job,
	JobBudget,
	JobEvent,
	JobStatus,
	NewJobEvent,
	Plan,
	Spec,
} from '@mf/models'
import type { Db } from './index.ts'
import type { JobsRepository } from './repositories.ts'

// MARK: Row mapping

type JobRow = {
	id: string
	order_id: string
	org_id: string
	status: JobStatus
	spec: Spec
	budget_tokens: number
	tokens_used: number
	max_workers: number
	max_duration_minutes: number
	plan: Plan | null
	reason: string | null
	gates: GateReport[] | null
	gate_waivers: string[] | null
	task_arn: string | null
	repository_url: string | null
	report_token_hash: string | null
	awaiting_approval: boolean
	approved: boolean
	started_at: Date | null
	finished_at: Date | null
	created_at: Date
}

type JobEventRow = {
	id: number | bigint
	job_id: string
	type: JobEvent['type']
	payload: Record<string, unknown>
	created_at: Date
}

const iso = (date: Date | null) => date?.toISOString()

export const toJob = (row: JobRow): Job => ({
	id: row.id,
	orderId: row.order_id,
	orgId: row.org_id,
	status: row.status,
	spec: row.spec,
	budget: {
		maxTokens: row.budget_tokens,
		maxWorkers: row.max_workers,
		maxDurationMinutes: row.max_duration_minutes,
	},
	tokensUsed: row.tokens_used,
	plan: row.plan ?? undefined,
	reason: row.reason ?? undefined,
	gates: row.gates ?? undefined,
	gateWaivers: row.gate_waivers?.length ? row.gate_waivers : undefined,
	taskArn: row.task_arn ?? undefined,
	repositoryUrl: row.repository_url ?? undefined,
	awaitingApproval: row.awaiting_approval || undefined,
	approved: row.approved || undefined,
	startedAt: iso(row.started_at),
	finishedAt: iso(row.finished_at),
	createdAt: row.created_at.toISOString(),
})

export const toJobEvent = (row: JobEventRow): JobEvent => ({
	id: Number(row.id),
	jobId: row.job_id,
	type: row.type,
	payload: row.payload,
	createdAt: row.created_at.toISOString(),
})

// MARK: Repository

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** `jobs.id` is a uuid column: a malformed id is "not found", not a Postgres 22P02 error */
export const isUuid = (value: string) => uuidPattern.test(value)

export type NewJob = {
	orderId: string
	orgId: string
	spec: Spec
	budget: JobBudget
	/** sha256 (hex) of the per-job report token the api hands to the build container */
	reportTokenHash?: string
}

export type JobUpdate = Partial<{
	status: JobStatus
	tokensUsed: number
	plan: Plan
	reason: string
	gates: GateReport[]
	gateWaivers: string[]
	taskArn: string
	repositoryUrl: string
	/** Set true when the job reaches the approve-before-deliver hold (W9) */
	awaitingApproval: boolean
	/** The resume signal for a held job: flipped by the approve action */
	approved: boolean
	startedAt: Date
	finishedAt: Date
	/** Rotated on the job's first report (one-shot bootstrap token); `null` revokes it */
	reportTokenHash: string | null
}>

export const insertJob = async (db: Db, job: NewJob): Promise<Job> => {
	const { sql } = db
	const [row] = await sql<JobRow[]>`
		insert into jobs (
			order_id, org_id, spec, budget_tokens, max_workers, max_duration_minutes, report_token_hash
		)
		values (
			${job.orderId}, ${job.orgId}, ${sql.json(job.spec as never)},
			${job.budget.maxTokens}, ${job.budget.maxWorkers}, ${job.budget.maxDurationMinutes},
			${job.reportTokenHash ?? null}
		)
		returning *`
	return toJob(row!)
}

export const getJob = async (db: Db, id: string): Promise<Job | undefined> => {
	if (!isUuid(id)) return undefined
	const [row] = await db.sql<JobRow[]>`select * from jobs where id = ${id}`
	return row && toJob(row)
}

/**
 * The job a report token belongs to (`/internal/jobs/:id` auth). Looks up by the hash alone so
 * the route can tell a wrong token (401) from a valid token used on another job's url (404).
 * The hash is never mapped onto `Job`, so it cannot leak through a response schema.
 */
export const getJobByReportToken = async (db: Db, tokenHash: string): Promise<Job | undefined> => {
	if (!tokenHash) return undefined
	const [row] = await db.sql<JobRow[]>`
		select * from jobs where report_token_hash = ${tokenHash} limit 1`
	return row && toJob(row)
}

export const listJobs = async (
	db: Db,
	filter: { orderId?: string; orgId?: string } = {}
): Promise<Job[]> => {
	const { sql } = db
	const rows = await sql<JobRow[]>`
		select * from jobs
		where true
			${filter.orderId === undefined ? sql`` : sql`and order_id = ${filter.orderId}`}
			${filter.orgId === undefined ? sql`` : sql`and org_id = ${filter.orgId}`}
		order by created_at desc
		limit 200`
	return rows.map(toJob)
}

/**
 * Active jobs (`queued`/`planning`/`building`/`verifying`) that were handed a Fargate task
 * (`task_arn is not null`) and are older than `olderThan` — the candidates the api's liveness
 * sweep re-checks against `ecs:DescribeTasks`. The age floor keeps a freshly-launched task,
 * which has not had time to boot and claim its token, out of the sweep. Oldest first.
 */
export const listStuckJobs = async (db: Db, olderThan: Date): Promise<Job[]> => {
	const { sql } = db
	const rows = await sql<JobRow[]>`
		select * from jobs
		where status in ${sql(activeJobStatus as readonly string[] as string[])}
			and task_arn is not null
			and created_at < ${olderThan}
		order by created_at asc
		limit 200`
	return rows.map(toJob)
}

export const updateJob = async (
	db: Db,
	id: string,
	update: JobUpdate
): Promise<Job | undefined> => {
	const { sql } = db
	const columns = {
		status: update.status,
		tokens_used: update.tokensUsed,
		plan: update.plan === undefined ? undefined : sql.json(update.plan as never),
		reason: update.reason,
		gates: update.gates === undefined ? undefined : sql.json(update.gates as never),
		gate_waivers:
			update.gateWaivers === undefined ? undefined : sql.json(update.gateWaivers as never),
		task_arn: update.taskArn,
		repository_url: update.repositoryUrl,
		// The approve-before-deliver hold ends when the job delivers: clear both flags so a
		// delivered job never keeps reading `awaiting_approval`/`approved` (W9).
		awaiting_approval: update.status === 'delivered' ? false : update.awaitingApproval,
		approved: update.status === 'delivered' ? false : update.approved,
		started_at: update.startedAt,
		finished_at: update.finishedAt,
		report_token_hash: update.reportTokenHash,
	}
	const set = Object.fromEntries(
		Object.entries(columns).filter(([, value]) => value !== undefined)
	) as Record<string, never>
	if (!Object.keys(set).length) return getJob(db, id)
	if (!isUuid(id)) return undefined

	// `killed` is terminal: a status write from the (possibly still running) job never overrides
	// the admin kill switch. Callers get `undefined` back and must treat that as killed.
	const [row] = await sql<JobRow[]>`
		update jobs set ${sql(set)}, updated_at = now()
		where id = ${id} ${update.status === undefined ? sql`` : sql`and status <> 'killed'`}
		returning *`
	return row && toJob(row)
}

export const appendEvent = async (db: Db, jobId: string, event: NewJobEvent): Promise<JobEvent> => {
	const { sql } = db
	const [row] = await sql<JobEventRow[]>`
		insert into job_events (job_id, type, payload)
		values (${jobId}, ${event.type}, ${sql.json(event.payload as never)})
		returning *`
	return toJobEvent(row!)
}

/**
 * Idempotent append for the build container's numbered events: the `(job_id, seq)` unique
 * index makes a replayed batch a no-op, and the caller gets the row that was stored the first
 * time with `duplicate: true` so it can skip the side effects.
 */
export const appendEventOnce = async (
	db: Db,
	jobId: string,
	seq: number,
	event: NewJobEvent
): Promise<{ event: JobEvent; duplicate: boolean }> => {
	const { sql } = db
	const [inserted] = await sql<JobEventRow[]>`
		insert into job_events (job_id, seq, type, payload)
		values (${jobId}, ${seq}, ${event.type}, ${sql.json(event.payload as never)})
		on conflict (job_id, seq) where seq is not null do nothing
		returning *`
	if (inserted) return { event: toJobEvent(inserted), duplicate: false }
	const [existing] = await sql<JobEventRow[]>`
		select * from job_events where job_id = ${jobId} and seq = ${seq}`
	if (!existing) throw new Error(`job_events (${jobId}, ${seq}) neither inserted nor found`)
	return { event: toJobEvent(existing), duplicate: true }
}

export const countEvents = async (
	db: Db,
	jobId: string,
	type: JobEvent['type']
): Promise<number> => {
	if (!isUuid(jobId)) return 0
	const [row] = await db.sql<{ count: string }[]>`
		select count(*)::text as count from job_events where job_id = ${jobId} and type = ${type}`
	return Number(row?.count ?? 0)
}

export const listEvents = async (db: Db, jobId: string, afterId = 0): Promise<JobEvent[]> => {
	if (!isUuid(jobId)) return []
	const rows = await db.sql<JobEventRow[]>`
		select * from job_events where job_id = ${jobId} and id > ${afterId}
		order by id asc limit 500`
	return rows.map(toJobEvent)
}

export const createJobsRepository = (db: Db): JobsRepository => ({
	insert: job => insertJob(db, job),
	get: id => getJob(db, id),
	getByReportToken: tokenHash => getJobByReportToken(db, tokenHash),
	list: filter => listJobs(db, filter),
	listStuck: olderThan => listStuckJobs(db, olderThan),
	update: (id, update) => updateJob(db, id, update),
	appendEvent: (jobId, event) => appendEvent(db, jobId, event),
	appendEventOnce: (jobId, seq, event) => appendEventOnce(db, jobId, seq, event),
	countEvents: (jobId, type) => countEvents(db, jobId, type),
	listEvents: (jobId, afterId) => listEvents(db, jobId, afterId),
})

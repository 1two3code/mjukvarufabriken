import type { Job, JobBudget, JobEvent, JobStatus, NewJobEvent, Plan, Spec } from '@mf/models'
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
	task_arn: string | null
	repository_url: string | null
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
	taskArn: row.task_arn ?? undefined,
	repositoryUrl: row.repository_url ?? undefined,
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
}

export type JobUpdate = Partial<{
	status: JobStatus
	tokensUsed: number
	plan: Plan
	reason: string
	taskArn: string
	repositoryUrl: string
	startedAt: Date
	finishedAt: Date
}>

export const insertJob = async (db: Db, job: NewJob): Promise<Job> => {
	const { sql } = db
	const [row] = await sql<JobRow[]>`
		insert into jobs (order_id, org_id, spec, budget_tokens, max_workers, max_duration_minutes)
		values (
			${job.orderId}, ${job.orgId}, ${sql.json(job.spec as never)},
			${job.budget.maxTokens}, ${job.budget.maxWorkers}, ${job.budget.maxDurationMinutes}
		)
		returning *`
	return toJob(row!)
}

export const getJob = async (db: Db, id: string): Promise<Job | undefined> => {
	if (!isUuid(id)) return undefined
	const [row] = await db.sql<JobRow[]>`select * from jobs where id = ${id}`
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
		task_arn: update.taskArn,
		repository_url: update.repositoryUrl,
		started_at: update.startedAt,
		finished_at: update.finishedAt,
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
	list: filter => listJobs(db, filter),
	update: (id, update) => updateJob(db, id, update),
	appendEvent: (jobId, event) => appendEvent(db, jobId, event),
	listEvents: (jobId, afterId) => listEvents(db, jobId, afterId),
})

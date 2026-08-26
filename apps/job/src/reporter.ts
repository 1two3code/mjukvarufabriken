/**
 * How the job talks to the outside world. `api` (Fargate) reports through the api's per-job
 * endpoint with the `JOB_TOKEN` from the RunTask override — the container never holds a
 * database credential (docs/M3-REVIEW.md #18). `db` writes to Postgres directly and is kept
 * for `npm run job:dev` against the local docker compose database.
 */
import { appendEvent, createDb, getJob, migrate, updateJob } from '@mf/db'

import type {
	JobReport,
	JobReportEventsResponse,
	JobReportUpdate,
	JobReportUpdateResponse,
	NewJobEvent,
} from '@mf/models'

export type JobReporter = {
	/** The job to run, or undefined when the id is unknown */
	load: () => Promise<JobReport | undefined>
	/** Appends one event; throws when it cannot be stored */
	emit: (event: NewJobEvent) => Promise<void>
	/** Status/tokens/plan/gates/urls; `killed` means the row is terminal and the status was refused */
	update: (update: JobReportUpdate) => Promise<JobReportUpdateResponse>
	/** Kill-switch poll */
	isKilled: () => Promise<boolean>
	close: () => Promise<void>
}

// MARK: api

export type ApiReporterOptions = {
	apiUrl: string
	jobId: string
	token: string
	/** Injected in tests; defaults to the global fetch (honours `NO_PROXY` for the api host) */
	fetch?: typeof fetch
	/** Retries per request on network errors / 5xx (default 3, exponential backoff from 500 ms) */
	retries?: number
	retryDelayMs?: number
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export class ApiReportError extends Error {
	constructor(
		readonly status: number,
		message: string
	) {
		super(message)
	}
}

export const createApiReporter = ({
	apiUrl,
	jobId,
	token,
	fetch: fetchImpl = fetch,
	retries = 3,
	retryDelayMs = 500,
}: ApiReporterOptions): JobReporter => {
	const base = `${apiUrl.replace(/\/+$/, '')}/internal/jobs/${encodeURIComponent(jobId)}`
	const headers = {
		authorization: `Bearer ${token}`,
		'content-type': 'application/json',
		accept: 'application/json',
	}

	/** One request with retries on transport errors and 5xx; 4xx is final */
	const request = async <T>(path: string, method: 'GET' | 'POST' | 'PATCH', body?: unknown) => {
		let lastError: Error = new Error('no attempt made')
		for (let attempt = 0; attempt <= retries; attempt += 1) {
			if (attempt > 0) await sleep(retryDelayMs * 2 ** (attempt - 1))
			try {
				const response = await fetchImpl(`${base}${path}`, {
					method,
					headers,
					body: body === undefined ? undefined : JSON.stringify(body),
				})
				if (response.ok) return (await response.json()) as T
				if (response.status === 404) return undefined
				const text = await response.text().catch(() => '')
				lastError = new ApiReportError(
					response.status,
					`${method} ${path} → ${response.status} ${text}`
				)
				if (response.status < 500) throw lastError
			} catch (error) {
				if (error instanceof ApiReportError && error.status < 500) throw error
				lastError = error as Error
			}
		}
		throw lastError
	}

	// Events are sent one request at a time, in order — a later event must never overtake an
	// earlier one (task_finished before task_started would confuse the portal timeline)
	let queue: Promise<unknown> = Promise.resolve()
	const enqueue = <T>(task: () => Promise<T>) => {
		const next = queue.then(task, task)
		queue = next.catch(() => {})
		return next
	}

	return {
		load: () => request<JobReport>('', 'GET'),
		emit: async event => {
			await enqueue(() => request<JobReportEventsResponse>('/events', 'POST', { events: [event] }))
		},
		update: async update => {
			const result = await enqueue(() => request<JobReportUpdateResponse>('', 'PATCH', update))
			if (!result) throw new ApiReportError(404, 'job not found')
			return result
		},
		isKilled: async () => (await request<JobReport>('', 'GET'))?.killed ?? false,
		close: async () => {
			await queue
		},
	}
}

// MARK: db (local development)

export const createDbReporter = async (
	databaseUrl: string,
	jobId: string
): Promise<JobReporter> => {
	const db = createDb(databaseUrl, { max: 3 })
	await migrate(db)
	const toDate = (value: string | undefined) => (value === undefined ? undefined : new Date(value))

	return {
		load: async () => {
			const job = await getJob(db, jobId)
			return (
				job && {
					id: job.id,
					status: job.status,
					spec: job.spec,
					budget: job.budget,
					gateWaivers: job.gateWaivers,
					killed: job.status === 'killed',
				}
			)
		},
		emit: async event => {
			await appendEvent(db, jobId, event)
		},
		update: async ({ startedAt, finishedAt, ...rest }) => {
			const row = await updateJob(db, jobId, {
				...rest,
				startedAt: toDate(startedAt),
				finishedAt: toDate(finishedAt),
			})
			if (row) return { status: row.status, killed: row.status === 'killed' }
			// Status refused by the killed-guard: keep usage, plan and gates like the api does
			const { status: _status, ...fields } = rest
			if (Object.keys(fields).length) {
				await updateJob(db, jobId, {
					...fields,
					startedAt: toDate(startedAt),
					finishedAt: toDate(finishedAt),
				})
			}
			return { status: 'killed', killed: true }
		},
		isKilled: async () => (await getJob(db, jobId))?.status === 'killed',
		close: () => db.close(),
	}
}

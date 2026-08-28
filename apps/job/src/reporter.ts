/**
 * How the job talks to the outside world. `api` (Fargate) reports through the api's per-job
 * endpoint with the `JOB_TOKEN` from the RunTask override — the container never holds a
 * database credential (docs/M3-REVIEW.md #18). `db` writes to Postgres directly and is kept
 * for `npm run job:dev` against the local docker compose database.
 */
import { appendEvent, createDb, getJob, getOrderRecord, migrate, updateJob } from '@mf/db'
import { jobReasonMaxLength } from '@mf/models'

import type {
	JobReport,
	JobReportEventsResponse,
	JobReportTokenResponse,
	JobReportUpdate,
	JobReportUpdateResponse,
	NewJobEvent,
} from '@mf/models'

export type JobReporter = {
	/**
	 * Exchanges the bootstrap credential for one only this process holds — called once, before
	 * anything else runs in the container. Absent when the reporter has no such credential.
	 */
	claim?: () => Promise<void>
	/** The job to run, or undefined when the id is unknown */
	load: () => Promise<JobReport | undefined>
	/** Appends one event; throws when it cannot be stored */
	emit: (event: NewJobEvent) => Promise<void>
	/** Status/tokens/plan/gates/urls; `killed` means the row is terminal and the status was refused */
	update: (update: JobReportUpdate) => Promise<JobReportUpdateResponse>
	/** Kill-switch poll */
	isKilled: () => Promise<boolean>
	/** Approve-before-deliver poll (W9): true once a human released the pre-delivery hold */
	isApproved: () => Promise<boolean>
	close: () => Promise<void>
}

const truncationMarker = '\n… (truncated)'

/** The api caps `reason`; the harness builds it from raw lint/test output, so cut, never fail */
export const truncateReason = (reason: string | undefined) =>
	reason === undefined || reason.length <= jobReasonMaxLength
		? reason
		: reason.slice(0, jobReasonMaxLength - truncationMarker.length) + truncationMarker

/** Keeps the fields a killed row still accepts (mirrors the api's `reportUpdate` fallback) */
const keepOnKilledRow = ({ tokensUsed, plan, gates }: JobReportUpdate) => ({
	...(tokensUsed !== undefined && { tokensUsed }),
	...(plan !== undefined && { plan }),
	...(gates !== undefined && { gates }),
})

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
	// No parameter properties: the job runs with Node type stripping only
	readonly status: number
	constructor(status: number, message: string) {
		super(message)
		this.status = status
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

	/**
	 * One request with retries on transport errors and 5xx; 4xx is final. Only a GET maps 404
	 * to `undefined` (unknown job) — a 404 on a write means events would silently vanish, so
	 * it throws like any other 4xx.
	 */
	const request = async <T>(
		path: string,
		method: 'GET' | 'POST' | 'PATCH',
		body?: unknown,
		attempts = retries
	) => {
		let lastError: Error = new Error('no attempt made')
		for (let attempt = 0; attempt <= attempts; attempt += 1) {
			if (attempt > 0) await sleep(retryDelayMs * 2 ** (attempt - 1))
			try {
				// No content-type without a body: Fastify rejects an empty JSON body with 400
				// (FST_ERR_CTP_EMPTY_JSON_BODY) — the first Fargate run with api reporting died on it
				const { 'content-type': contentType, ...bodiless } = headers
				const response = await fetchImpl(`${base}${path}`, {
					method,
					headers: body === undefined ? bodiless : { ...bodiless, 'content-type': contentType },
					body: body === undefined ? undefined : JSON.stringify(body),
				})
				if (response.ok) return (await response.json()) as T
				if (response.status === 404 && method === 'GET') return undefined
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

	// Every event carries its number so a batch retried after a lost response is stored once
	let seq = 0

	return {
		// Single attempt (retries=0): the endpoint rotates the report token on the first hit, so a
		// retry that still presents the bootstrap token (this closure only swaps `authorization` after
		// a success) would meet the already-rotated hash and 401. Retrying cannot recover a lost
		// response — the minted token is gone server-side — so surface the failure once and let the
		// caller fail the job cleanly rather than compound it with a misleading 401.
		claim: async () => {
			const result = await request<JobReportTokenResponse>('/token', 'POST', undefined, 0)
			if (!result) throw new ApiReportError(404, 'job not found')
			headers.authorization = `Bearer ${result.token}`
		},
		load: () => request<JobReport>('', 'GET'),
		emit: async event => {
			seq += 1
			const numbered = { ...event, seq }
			await enqueue(() =>
				request<JobReportEventsResponse>('/events', 'POST', { events: [numbered] })
			)
		},
		update: async update => {
			const body = { ...update, reason: truncateReason(update.reason) }
			if (body.reason === undefined) delete body.reason
			const result = await enqueue(() => request<JobReportUpdateResponse>('', 'PATCH', body))
			if (!result) throw new ApiReportError(404, 'job not found')
			return result
		},
		// A revoked token (401) means the api ended the job — same as the kill flag for the poll
		isKilled: async () =>
			request<JobReport>('', 'GET').then(
				report => report?.killed ?? false,
				error => {
					if (error instanceof ApiReportError && error.status === 401) return true
					throw error
				}
			),
		// The pre-delivery hold's resume signal (W9). A 401 means the api ended the job; the poll
		// treats that as "not approved" and lets `isKilled` abort the run on its own next round.
		isApproved: async () =>
			request<JobReport>('', 'GET').then(
				report => report?.approved ?? false,
				error => {
					if (error instanceof ApiReportError && error.status === 401) return false
					throw error
				}
			),
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
			if (!job) return undefined
			const order = await getOrderRecord(db, job.orderId)
			return {
				id: job.id,
				status: job.status,
				spec: job.spec,
				budget: job.budget,
				gateWaivers: job.gateWaivers,
				killed: job.status === 'killed',
				approveBeforeDeliver: order?.approveBeforeDeliver ?? false,
				approved: job.approved ?? false,
			}
		},
		emit: async event => {
			await appendEvent(db, jobId, event)
		},
		update: async update => {
			const { startedAt, finishedAt, ...rest } = update
			const row = await updateJob(db, jobId, {
				...rest,
				reason: truncateReason(rest.reason),
				startedAt: toDate(startedAt),
				finishedAt: toDate(finishedAt),
			})
			if (row) return { status: row.status, killed: row.status === 'killed' }
			// Status refused by the killed-guard: keep usage, plan and gates like the api does —
			// never the reason or the timestamps, which are the admin's kill
			const fields = keepOnKilledRow(update)
			if (Object.keys(fields).length) await updateJob(db, jobId, fields)
			return { status: 'killed', killed: true }
		},
		isKilled: async () => (await getJob(db, jobId))?.status === 'killed',
		isApproved: async () => (await getJob(db, jobId))?.approved ?? false,
		close: () => db.close(),
	}
}

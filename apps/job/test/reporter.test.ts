import { jobReasonMaxLength } from '@mf/models'

import { ApiReportError, createApiReporter, truncateReason } from '#/reporter.ts'

type Call = { url: string; method: string; body: unknown; authorization: string | undefined }

/** A fetch stub that records calls and replays the queued responses (last one repeats) */
const createFetchStub = (responses: { status: number; body?: unknown }[]) => {
	const calls: Call[] = []
	const queue = [...responses]
	const fetchStub = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
		const headers = init?.headers as Record<string, string>
		calls.push({
			url: String(url),
			method: init?.method ?? 'GET',
			body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
			authorization: headers?.authorization,
		})
		const next = queue.length > 1 ? queue.shift()! : queue[0]!
		return new Response(next.body === undefined ? '' : JSON.stringify(next.body), {
			status: next.status,
			headers: { 'content-type': 'application/json' },
		})
	}) as unknown as typeof fetch
	return { fetchStub, calls }
}

const options = (fetchStub: typeof fetch) => ({
	apiUrl: 'http://api.internal/',
	jobId: 'job-1',
	token: 'secret',
	fetch: fetchStub,
	retries: 2,
	retryDelayMs: 1,
})

describe('api reporter', () => {
	it('Loads the job with the bearer token from the per-job url', async () => {
		const job = { id: 'job-1', status: 'queued', spec: {}, budget: {}, killed: false }
		const { fetchStub, calls } = createFetchStub([{ status: 200, body: job }])

		const loaded = await createApiReporter(options(fetchStub)).load()

		expect(loaded).toEqual(job)
		expect(calls[0]).toEqual({
			url: 'http://api.internal/internal/jobs/job-1',
			method: 'GET',
			body: undefined,
			authorization: 'Bearer secret',
		})
	})

	it('Returns undefined for an unknown job and false from the kill poll', async () => {
		const { fetchStub } = createFetchStub([{ status: 404, body: { error: {} } }])
		const reporter = createApiReporter(options(fetchStub))

		await expect(reporter.load()).resolves.toBeUndefined()
		await expect(reporter.isKilled()).resolves.toBe(false)
	})

	it('Treats a 404 on a write as an error, never as a stored event', async () => {
		const { fetchStub } = createFetchStub([{ status: 404, body: { error: {} } }])
		const reporter = createApiReporter(options(fetchStub))

		await expect(reporter.emit({ type: 'log', payload: {} })).rejects.toMatchObject({
			status: 404,
		})
		await expect(reporter.update({ tokensUsed: 1 })).rejects.toMatchObject({ status: 404 })
		expect(fetchStub).toHaveBeenCalledTimes(2)
	})

	it('Exchanges the bootstrap token once and uses the fresh one from then on', async () => {
		const { fetchStub, calls } = createFetchStub([
			{ status: 200, body: { token: 'fresh' } },
			{ status: 200, body: { id: 'job-1', killed: false } },
		])
		const reporter = createApiReporter(options(fetchStub))

		await reporter.claim!()
		await reporter.load()

		expect(
			calls.map(call => [call.method, call.url.split('/').at(-1), call.authorization])
		).toEqual([
			['POST', 'token', 'Bearer secret'],
			['GET', 'job-1', 'Bearer fresh'],
		])
	})

	it('Does not retry the token exchange (a rotated bootstrap token never re-authenticates)', async () => {
		// A 5xx that every other request would retry: the token endpoint rotates on its first hit, so
		// a retry re-presenting the now-stale bootstrap token only earns a misleading 401 — claim must
		// make a single attempt and surface the failure for the caller to fail the job cleanly.
		const { fetchStub } = createFetchStub([{ status: 502, body: { error: {} } }])
		const reporter = createApiReporter(options(fetchStub))

		await expect(reporter.claim!()).rejects.toMatchObject({ status: 502 })
		expect(fetchStub).toHaveBeenCalledTimes(1)
	})

	it('Posts events one at a time, in order and numbered, and patches updates', async () => {
		const { fetchStub, calls } = createFetchStub([
			{ status: 200, body: { lastEventId: 1 } },
			{ status: 200, body: { lastEventId: 2 } },
			{ status: 200, body: { status: 'building', killed: false } },
		])
		const reporter = createApiReporter(options(fetchStub))

		await Promise.all([
			reporter.emit({ type: 'started', payload: { a: 1 } }),
			reporter.emit({ type: 'planned', payload: { b: 2 } }),
		])
		const result = await reporter.update({ status: 'building', tokensUsed: 5 })

		expect(calls.map(call => [call.method, call.url.split('/').at(-1), call.body])).toEqual([
			['POST', 'events', { events: [{ type: 'started', payload: { a: 1 }, seq: 1 }] }],
			['POST', 'events', { events: [{ type: 'planned', payload: { b: 2 }, seq: 2 }] }],
			['PATCH', 'job-1', { status: 'building', tokensUsed: 5 }],
		])
		expect(result).toEqual({ status: 'building', killed: false })
	})

	it('Resends an event with the same number after a 5xx (the api stores it once)', async () => {
		const { fetchStub, calls } = createFetchStub([
			{ status: 502, body: {} },
			{ status: 200, body: { lastEventId: 1 } },
		])

		await createApiReporter(options(fetchStub)).emit({ type: 'log', payload: {} })

		expect(calls.map(call => call.body)).toEqual([
			{ events: [{ type: 'log', payload: {}, seq: 1 }] },
			{ events: [{ type: 'log', payload: {}, seq: 1 }] },
		])
	})

	it('Truncates an over-long reason so the final PATCH is never rejected', async () => {
		const { fetchStub, calls } = createFetchStub([
			{ status: 200, body: { status: 'failed', killed: false } },
		])
		const reason = 'x'.repeat(jobReasonMaxLength + 5000)

		await createApiReporter(options(fetchStub)).update({ status: 'failed', reason })

		const sent = (calls[0]!.body as { reason: string }).reason
		expect(sent).toHaveLength(jobReasonMaxLength)
		expect(sent.endsWith('… (truncated)')).toBe(true)
		expect(truncateReason('short')).toBe('short')
		expect(truncateReason(undefined)).toBeUndefined()
	})

	it('Reads a revoked token (401) on the poll as killed', async () => {
		const { fetchStub } = createFetchStub([{ status: 401, body: { error: {} } }])

		await expect(createApiReporter(options(fetchStub)).isKilled()).resolves.toBe(true)
	})

	it('Reads `approved` from the approval poll (true when set, false when absent)', async () => {
		const approved = createFetchStub([{ status: 200, body: { id: 'job-1', approved: true } }])
		await expect(createApiReporter(options(approved.fetchStub)).isApproved()).resolves.toBe(true)

		const unset = createFetchStub([{ status: 200, body: { id: 'job-1' } }])
		await expect(createApiReporter(options(unset.fetchStub)).isApproved()).resolves.toBe(false)
	})

	it('Returns false from the approval poll for an unknown job (404)', async () => {
		const { fetchStub } = createFetchStub([{ status: 404, body: { error: {} } }])

		await expect(createApiReporter(options(fetchStub)).isApproved()).resolves.toBe(false)
	})

	it('Reads a revoked token (401) on the approval poll as not approved', async () => {
		// A killed job's token is revoked; the approval poll must not read that as an approval — it
		// returns false and lets `isKilled` abort the run on its own next round.
		const { fetchStub } = createFetchStub([{ status: 401, body: { error: {} } }])

		await expect(createApiReporter(options(fetchStub)).isApproved()).resolves.toBe(false)
	})

	it('Retries on 5xx and network errors, then succeeds', async () => {
		const { fetchStub, calls } = createFetchStub([
			{ status: 503, body: { error: {} } },
			{ status: 200, body: { killed: true } },
		])
		let first = true
		const flaky = vi.fn((url: string, init?: RequestInit) => {
			if (first) {
				first = false
				return Promise.reject(new Error('ECONNRESET'))
			}
			return fetchStub(url, init)
		}) as unknown as typeof fetch

		const killed = await createApiReporter(options(flaky)).isKilled()

		expect(killed).toBe(true)
		expect(flaky).toHaveBeenCalledTimes(3)
		expect(calls).toHaveLength(2)
	})

	it('Gives up on 401 immediately (a wrong token never becomes right)', async () => {
		const { fetchStub } = createFetchStub([{ status: 401, body: { error: {} } }])
		const reporter = createApiReporter(options(fetchStub))

		await expect(reporter.emit({ type: 'log', payload: {} })).rejects.toBeInstanceOf(ApiReportError)
		expect(fetchStub).toHaveBeenCalledTimes(1)
	})

	it('Keeps sending after a failed event (the queue never poisons itself)', async () => {
		const { fetchStub, calls } = createFetchStub([
			{ status: 401, body: {} },
			{ status: 200, body: { lastEventId: 3 } },
		])
		const reporter = createApiReporter(options(fetchStub))

		await expect(reporter.emit({ type: 'log', payload: {} })).rejects.toThrow()
		await expect(reporter.emit({ type: 'log', payload: {} })).resolves.toBeUndefined()
		expect(calls).toHaveLength(2)
	})
})

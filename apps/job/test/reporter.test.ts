import { ApiReportError, createApiReporter } from '#/reporter.ts'

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

	it('Posts events one at a time, in order, and patches updates', async () => {
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
			['POST', 'events', { events: [{ type: 'started', payload: { a: 1 } }] }],
			['POST', 'events', { events: [{ type: 'planned', payload: { b: 2 } }] }],
			['PATCH', 'job-1', { status: 'building', tokensUsed: 5 }],
		])
		expect(result).toEqual({ status: 'building', killed: false })
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

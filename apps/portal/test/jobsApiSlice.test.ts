import { configureStore } from '@reduxjs/toolkit'

import type { Job } from '@mf/models'

// `sessionSlice` (pulled in by app/api.ts) reads localStorage at module scope
vi.stubGlobal('localStorage', {
	getItem: () => null,
	setItem: () => undefined,
	removeItem: () => undefined,
})

// RTK builds a `Request` before it hands the call to `fetch`, and node needs an absolute url for
// that. Set before `app/api.ts` is imported, which reads the base url at module scope.
vi.stubEnv('VITE_API_URL', 'http://portal.test/bff')

// Every request the store makes, in order. `fetchBaseQuery` captures `globalThis.fetch` when the
// api is created, so the stub has to be in place before `app/api.ts` is imported below.
const requests: string[] = []
const server = { killed: false }
/** How long the job row takes to answer; the echo assertion below must beat it */
const jobDelayMs = 300
const jsonResponse = (body: unknown) =>
	new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
	const url = input instanceof Request ? input.url : String(input)
	requests.push(url)
	if (url.endsWith('/kill')) {
		server.killed = true
		return Promise.resolve(jsonResponse(job('killed')))
	}
	if (url.includes('/events')) return Promise.resolve(jsonResponse([]))
	// The order's job list is the frozen view: it keeps answering `building` unless it is refetched
	if (url.endsWith('/jobs')) return Promise.resolve(jsonResponse([job('building')]))
	// The job row, deliberately slow, so the optimistic echo is observable before the refetch lands
	return new Promise<Response>(resolve =>
		setTimeout(() => resolve(jsonResponse(job(server.killed ? 'killed' : 'building'))), jobDelayMs)
	)
})

const { appApi } = await import('#/app/api.ts')
const { jobsApiSlice } = await import('#/features/jobs/jobsApiSlice.ts')

const job = (status: Job['status']): Job =>
	({ id: 'job-1', orderId: 'order-1', status }) as unknown as Job

/** A store with just the api slice — the auth guard only reads `session.token`. */
const makeStore = () =>
	configureStore({
		reducer: {
			[appApi.reducerPath]: appApi.reducer,
			session: () => ({ token: null, refreshToken: null }),
		},
		middleware: getDefault => getDefault().concat(appApi.middleware),
	})

// The list keeps answering `building`; only the kill response is terminal. If the kill does not
// invalidate, the list is never asked again and the portal keeps showing `building`.
describe('killJob cache invalidation', () => {
	beforeEach(() => {
		requests.length = 0
		server.killed = false
	})

	const countOf = (fragment: string) => requests.filter(url => url.includes(fragment)).length

	it("Refetches the order's job list and the event log after a kill", async () => {
		const store = makeStore()
		// Live subscriptions, exactly as the order page and the job page hold them
		store.dispatch(jobsApiSlice.endpoints.getOrderJobs.initiate('order-1'))
		store.dispatch(jobsApiSlice.endpoints.getJobEvents.initiate({ jobId: 'job-1', after: 0 }))
		await vi.waitFor(() => expect(countOf('/orders/order-1/jobs')).toBe(1))
		await vi.waitFor(() => expect(countOf('/jobs/job-1/events')).toBe(1))

		await store.dispatch(jobsApiSlice.endpoints.killJob.initiate('job-1'))

		await vi.waitFor(() => expect(countOf('/orders/order-1/jobs')).toBe(2))
		await vi.waitFor(() => expect(countOf('/jobs/job-1/events')).toBe(2))
	})

	it('Echoes the killed row into the open job view immediately', async () => {
		const store = makeStore()
		// The store here is assembled by hand, so its state does not carry the api's tag types
		const jobStatus = () =>
			jobsApiSlice.endpoints.getJob.select('job-1')(store.getState() as any).data?.status

		store.dispatch(jobsApiSlice.endpoints.getJob.initiate('job-1'))
		await vi.waitFor(() => expect(jobStatus()).toBe('building'))

		await store.dispatch(jobsApiSlice.endpoints.killJob.initiate('job-1'))

		// The upsert echoes the killed row straight into the cache: it must be visible well before
		// the refetch the invalidation triggered can answer (that one takes `jobDelayMs`).
		await vi.waitFor(() => expect(jobStatus()).toBe('killed'), { timeout: jobDelayMs / 3 })
	})
})

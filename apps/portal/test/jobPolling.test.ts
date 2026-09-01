import {
	isPollableJobStatus,
	jobPollingInterval,
	jobPollingIntervalMs,
	latestJobStatus,
	terminalJobStatus,
} from '#/features/jobs/polling.ts'

import type { ReactElement } from 'react'
import type { Job, JobStatus } from '@mf/models'

// `sessionSlice` reads localStorage at module scope, and JobPage pulls it in through `Has`.
vi.stubGlobal('localStorage', {
	getItem: () => null,
	setItem: () => undefined,
	removeItem: () => undefined,
})

// Per-test-controllable query state for the two hooks JobPage subscribes to, plus a record of the
// options each was called with — the polling interval is the thing under test.
const hooks = vi.hoisted(() => ({
	jobs: undefined as unknown[] | undefined,
	cachedJob: undefined as unknown,
	jobQueryOptions: undefined as { skip?: boolean; pollingInterval?: number } | undefined,
}))

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('react-router-dom', () => ({
	useParams: () => ({ orderId: 'order-1' }),
	Link: 'a',
}))
vi.mock('#/features/jobs/jobsApiSlice.ts', () => ({
	jobsApiSlice: {
		endpoints: { getJob: { useQueryState: () => ({ data: hooks.cachedJob }) } },
	},
	useGetOrderJobsQuery: () => ({ data: hooks.jobs, isLoading: false, isError: false }),
	useGetJobQuery: (_id: string, options: { skip?: boolean; pollingInterval?: number }) => {
		hooks.jobQueryOptions = options
		return { data: hooks.cachedJob }
	},
	useGetJobEventsQuery: () => ({ data: [] }),
	useGetJobDeliverablesQuery: () => ({ data: undefined }),
	useStartJobMutation: () => [vi.fn(), { isLoading: false }] as const,
	useKillJobMutation: () => [vi.fn(), { isLoading: false }] as const,
}))

const { JobPage } = await import('#/pages/JobPage.tsx')

const makeJob = (status: JobStatus): Job => ({ id: 'job-1', status }) as unknown as Job

describe('Job polling', () => {
	describe('isPollableJobStatus', () => {
		it('Stops only at the three terminal statuses', () => {
			for (const status of terminalJobStatus) {
				expect(isPollableJobStatus(status), status).toBe(false)
			}
			for (const status of ['queued', 'planning', 'building', 'verifying'] as const) {
				expect(isPollableJobStatus(status), status).toBe(true)
			}
		})
	})

	describe('latestJobStatus', () => {
		it('Prefers the polled detail row over the frozen order list', () => {
			// The order's job list is fetched once at mount: it still says `building` long after the
			// build finished. Only the polled row knows the job is done.
			expect(latestJobStatus(makeJob('delivered'), [makeJob('building')])).toBe('delivered')
			expect(latestJobStatus(undefined, [makeJob('building')])).toBe('building')
			expect(latestJobStatus(undefined, [])).toBeUndefined()
			expect(latestJobStatus(undefined, undefined)).toBeUndefined()
		})
	})

	describe('jobPollingInterval', () => {
		it('Polls while the job is live', () => {
			expect(jobPollingInterval(makeJob('building'), [makeJob('building')])).toBe(
				jobPollingIntervalMs
			)
			expect(jobPollingInterval(undefined, [makeJob('queued')])).toBe(jobPollingIntervalMs)
		})

		it('Stops as soon as the polled row is terminal, whatever the list still says', () => {
			for (const status of terminalJobStatus) {
				expect(jobPollingInterval(makeJob(status), [makeJob('building')]), status).toBe(0)
			}
		})

		it('Does not poll before there is a job', () => {
			expect(jobPollingInterval(undefined, undefined)).toBe(0)
		})
	})

	// The regression: JobPage derived "is this job active?" from the un-polled list, so a page left
	// open on a finished job kept firing a request every 3 s for ever (~9 600 a night per tab).
	describe('JobPage', () => {
		beforeEach(() => {
			hooks.jobs = undefined
			hooks.cachedJob = undefined
			hooks.jobQueryOptions = undefined
		})

		const render = () => JobPage() as ReactElement

		it('Polls the job while it is building', () => {
			hooks.jobs = [makeJob('building')]
			hooks.cachedJob = makeJob('building')
			render()
			expect(hooks.jobQueryOptions?.pollingInterval).toBe(jobPollingIntervalMs)
		})

		it('Stops polling once the job is delivered, though the list still says building', () => {
			hooks.jobs = [makeJob('building')]
			hooks.cachedJob = makeJob('delivered')
			render()
			expect(hooks.jobQueryOptions?.pollingInterval).toBe(0)
		})

		it('Stops polling a killed job', () => {
			hooks.jobs = [makeJob('building')]
			hooks.cachedJob = makeJob('killed')
			render()
			expect(hooks.jobQueryOptions?.pollingInterval).toBe(0)
		})

		it('Skips the job query entirely when the order has no jobs', () => {
			hooks.jobs = []
			render()
			expect(hooks.jobQueryOptions?.skip).toBe(true)
			expect(hooks.jobQueryOptions?.pollingInterval).toBe(0)
		})
	})
})

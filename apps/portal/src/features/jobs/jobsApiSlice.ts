import { ApiCaching, appApi } from '#/app/api.ts'

import type { Job, JobEvent } from '@mf/models'

export const jobsApiSlice = appApi
	.enhanceEndpoints({ addTagTypes: ['job', 'jobEvents'] })
	.injectEndpoints({
		endpoints: build => ({
			getOrderJobs: build.query<Job[], string>({
				query: orderId => `/orders/${orderId}/jobs`,
				providesTags: (_result, _error, orderId) => [{ type: 'job', id: `order-${orderId}` }],
				keepUnusedDataFor: ApiCaching.none,
			}),
			getJob: build.query<Job, string>({
				query: jobId => `/jobs/${jobId}`,
				providesTags: (_result, _error, jobId) => [{ type: 'job', id: jobId }],
				keepUnusedDataFor: ApiCaching.none,
			}),
			/**
			 * Incremental event log. The cache key is the job id only; each poll asks for events
			 * after the last id we have and merges them, so the page never re-downloads the log.
			 */
			getJobEvents: build.query<JobEvent[], { jobId: string; after: number }>({
				query: ({ jobId, after }) => `/jobs/${jobId}/events?after=${after}`,
				serializeQueryArgs: ({ queryArgs }) => queryArgs.jobId,
				merge: (current, incoming) => {
					const known = new Set(current.map(event => event.id))
					current.push(...incoming.filter(event => !known.has(event.id)))
				},
				forceRefetch: ({ currentArg, previousArg }) => currentArg?.after !== previousArg?.after,
				providesTags: (_result, _error, { jobId }) => [{ type: 'jobEvents', id: jobId }],
				keepUnusedDataFor: ApiCaching.none,
			}),
			startJob: build.mutation<Job, string>({
				query: orderId => ({ url: `/orders/${orderId}/jobs`, method: 'POST' }),
				invalidatesTags: (_result, _error, orderId) => [{ type: 'job', id: `order-${orderId}` }],
			}),
			killJob: build.mutation<Job, string>({
				query: jobId => ({ url: `/admin/jobs/${jobId}/kill`, method: 'POST' }),
				async onQueryStarted(jobId, { dispatch, queryFulfilled }) {
					const { data } = await queryFulfilled
					dispatch(jobsApiSlice.util.upsertQueryData('getJob', jobId, data))
				},
			}),
		}),
	})

export const {
	useGetOrderJobsQuery,
	useGetJobQuery,
	useGetJobEventsQuery,
	useStartJobMutation,
	useKillJobMutation,
} = jobsApiSlice

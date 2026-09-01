import { ApiCaching, appApi } from '#/app/api.ts'

import type { DeliverablesResponse, Job, JobEvent } from '@mf/models'

export const jobsApiSlice = appApi
	.enhanceEndpoints({ addTagTypes: ['job', 'jobEvents'] })
	.injectEndpoints({
		endpoints: build => ({
			/** The delivery record with presigned links (M5); 404 until the job's bundle landed */
			getJobDeliverables: build.query<DeliverablesResponse, string>({
				query: jobId => `/jobs/${jobId}/deliverables`,
				providesTags: (_result, _error, jobId) => [{ type: 'job', id: `deliverables-${jobId}` }],
			}),
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
				// The upsert echoes the killed row into the open job view immediately; the tags then
				// refresh everything else that still shows the pre-kill status — the order's job list
				// (order page and the "a build is running" affordances) and the event log, which gains
				// a `killed` event. Without them an admin kills a runaway build and the rest of the
				// portal keeps saying `building` until a reload.
				invalidatesTags: (result, _error, jobId) => [
					{ type: 'job', id: jobId },
					{ type: 'jobEvents', id: jobId },
					...(result ? [{ type: 'job' as const, id: `order-${result.orderId}` }] : []),
				],
				async onQueryStarted(jobId, { dispatch, queryFulfilled }) {
					const { data } = await queryFulfilled
					dispatch(jobsApiSlice.util.upsertQueryData('getJob', jobId, data))
				},
			}),
		}),
	})

export const {
	useGetJobDeliverablesQuery,
	useGetOrderJobsQuery,
	useGetJobQuery,
	useGetJobEventsQuery,
	useStartJobMutation,
	useKillJobMutation,
} = jobsApiSlice

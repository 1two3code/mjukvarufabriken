import { ApiCaching, appApi } from '#/app/api.ts'

import type { Job, Order, Org } from '@mf/models'

export const adminApiSlice = appApi
	.enhanceEndpoints({ addTagTypes: ['adminJobs', 'adminOrders', 'adminOrgs'] })
	.injectEndpoints({
		endpoints: build => ({
			getAdminJobs: build.query<Job[], void>({
				query: () => '/admin/jobs',
				providesTags: ['adminJobs'],
				keepUnusedDataFor: ApiCaching.none,
			}),
			getAdminOrders: build.query<Order[], void>({
				query: () => '/admin/orders',
				providesTags: ['adminOrders'],
			}),
			getAdminOrgs: build.query<Org[], void>({
				query: () => '/admin/orgs',
				providesTags: ['adminOrgs'],
			}),
			killAdminJob: build.mutation<Job, string>({
				query: jobId => ({ url: `/admin/jobs/${jobId}/kill`, method: 'POST' }),
				invalidatesTags: ['adminJobs'],
			}),
		}),
	})

export const {
	useGetAdminJobsQuery,
	useGetAdminOrdersQuery,
	useGetAdminOrgsQuery,
	useKillAdminJobMutation,
} = adminApiSlice

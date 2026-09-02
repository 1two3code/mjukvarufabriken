import { ApiCaching, appApi } from '#/app/api.ts'

import type {
	DemoQueueResponse,
	Job,
	ModelPriceRow,
	NewModelPrice,
	Order,
	OrderMutation,
	Org,
	ProvisionAccountResponse,
} from '@mf/models'

export const adminApiSlice = appApi
	.enhanceEndpoints({
		addTagTypes: ['adminJobs', 'adminOrders', 'adminOrgs', 'modelPrices', 'demoQueue'],
	})
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
			/** Paid voucher demos waiting for a build approval, plus the weekly cap state (wave 14) */
			getDemoQueue: build.query<DemoQueueResponse, void>({
				query: () => '/admin/orders/demo-queue',
				providesTags: ['demoQueue'],
				keepUnusedDataFor: ApiCaching.none,
			}),
			/** Approves a demo's build (`force` bypasses the weekly cap); the build starts at once */
			approveDemoBuild: build.mutation<Order, { orderId: string } & OrderMutation['ApproveBuild']>({
				query: ({ orderId, ...body }) => ({
					url: `/admin/orders/${orderId}/approve-build`,
					method: 'POST',
					body,
				}),
				invalidatesTags: ['demoQueue', 'adminOrders', 'adminJobs'],
			}),
			getAdminOrgs: build.query<Org[], void>({
				query: () => '/admin/orgs',
				providesTags: ['adminOrgs'],
			}),
			getModelPrices: build.query<ModelPriceRow[], void>({
				query: () => '/admin/model-prices',
				providesTags: ['modelPrices'],
			}),
			addModelPrice: build.mutation<ModelPriceRow, NewModelPrice>({
				query: body => ({ url: '/admin/model-prices', method: 'POST', body }),
				invalidatesTags: ['modelPrices'],
			}),
			killAdminJob: build.mutation<Job, string>({
				query: jobId => ({ url: `/admin/jobs/${jobId}/kill`, method: 'POST' }),
				invalidatesTags: ['adminJobs'],
			}),
			provisionAccount: build.mutation<ProvisionAccountResponse, string>({
				query: orgId => ({ url: `/admin/orgs/${orgId}/provision-account`, method: 'POST' }),
				invalidatesTags: ['adminOrgs'],
			}),
		}),
	})

export const {
	useGetAdminJobsQuery,
	useGetAdminOrdersQuery,
	useGetDemoQueueQuery,
	useApproveDemoBuildMutation,
	useGetAdminOrgsQuery,
	useGetModelPricesQuery,
	useAddModelPriceMutation,
	useKillAdminJobMutation,
	useProvisionAccountMutation,
} = adminApiSlice

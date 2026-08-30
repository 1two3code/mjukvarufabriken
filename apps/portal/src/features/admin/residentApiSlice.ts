import { ApiCaching, appApi } from '#/app/api.ts'

import type {
	ResidentBillingRunResponse,
	ResidentInstallation,
	ResidentInstallationMutation,
	ResidentUsageQuery,
	ResidentUsageSummary,
} from '@mf/models'

/** Admin view of the resident installations (M8) and their monthly metered usage */
export const residentApiSlice = appApi
	.enhanceEndpoints({ addTagTypes: ['residentInstallations', 'residentUsage'] })
	.injectEndpoints({
		endpoints: build => ({
			getResidentInstallations: build.query<ResidentInstallation[], void>({
				query: () => '/admin/resident/installations',
				providesTags: ['residentInstallations'],
			}),
			getResidentUsage: build.query<ResidentUsageSummary[], ResidentUsageQuery>({
				query: params => ({ url: '/admin/resident/usage', params }),
				providesTags: ['residentUsage'],
				keepUnusedDataFor: ApiCaching.none,
			}),
			/** Reports the month's unbilled usage of every installation to the payment provider */
			billResidentMonth: build.mutation<ResidentBillingRunResponse, string>({
				query: month => ({ url: `/admin/resident/usage/${month}/bill`, method: 'POST' }),
				invalidatesTags: ['residentUsage'],
			}),
			upsertResidentInstallation: build.mutation<
				ResidentInstallation,
				{ id: string } & ResidentInstallationMutation['UpsertInstallation']
			>({
				query: ({ id, ...body }) => ({
					url: `/admin/resident/installations/${id}`,
					method: 'PUT',
					body,
				}),
				invalidatesTags: ['residentInstallations', 'residentUsage'],
			}),
		}),
	})

export const {
	useGetResidentInstallationsQuery,
	useGetResidentUsageQuery,
	useBillResidentMonthMutation,
	useUpsertResidentInstallationMutation,
} = residentApiSlice

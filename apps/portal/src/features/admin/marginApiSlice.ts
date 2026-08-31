import { ApiCaching, appApi } from '#/app/api.ts'

import type { CustomerRevenue, InfraCostAllocation } from '@mf/models'

/** M12 margin calculator: the two read-only margin endpoints (PR #46) */
export const marginApiSlice = appApi
	.enhanceEndpoints({ addTagTypes: ['marginRevenue', 'marginInfraCost'] })
	.injectEndpoints({
		endpoints: build => ({
			getMarginRevenue: build.query<CustomerRevenue[], void>({
				query: () => '/admin/margin/revenue',
				providesTags: ['marginRevenue'],
				keepUnusedDataFor: ApiCaching.none,
			}),
			getMarginInfraCost: build.query<InfraCostAllocation, void>({
				query: () => '/admin/margin/infra-cost',
				providesTags: ['marginInfraCost'],
			}),
		}),
	})

export const { useGetMarginRevenueQuery, useGetMarginInfraCostQuery } = marginApiSlice

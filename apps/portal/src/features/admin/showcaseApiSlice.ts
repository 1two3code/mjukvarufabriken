import { appApi } from '#/app/api.ts'

import type { Showcase, ShowcaseAdminRow, ShowcaseMutation } from '@mf/models'

export const showcaseApiSlice = appApi
	.enhanceEndpoints({ addTagTypes: ['adminShowcases'] })
	.injectEndpoints({
		endpoints: build => ({
			getAdminShowcases: build.query<ShowcaseAdminRow[], void>({
				query: () => '/admin/showcases',
				providesTags: ['adminShowcases'],
			}),
			upsertShowcase: build.mutation<
				Showcase,
				{ orderId: string } & ShowcaseMutation['UpsertShowcase']
			>({
				query: ({ orderId, ...body }) => ({
					url: `/admin/orders/${orderId}/showcase`,
					method: 'PUT',
					body,
				}),
				invalidatesTags: ['adminShowcases'],
			}),
		}),
	})

export const { useGetAdminShowcasesQuery, useUpsertShowcaseMutation } = showcaseApiSlice

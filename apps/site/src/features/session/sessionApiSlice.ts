import { ApiCaching, appApi } from '#/app/api.ts'

import type { FrontendSession } from '@mf/models'

export const sessionApiSlice = appApi
	.enhanceEndpoints({ addTagTypes: ['session'] })
	.injectEndpoints({
		endpoints: build => ({
			getSession: build.query<FrontendSession, void>({
				keepUnusedDataFor: ApiCaching.long,
				query: () => '/session',
				providesTags: ['session'],
			}),
		}),
	})

export const { useGetSessionQuery } = sessionApiSlice

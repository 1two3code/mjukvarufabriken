import { appApi } from '#/app/api.ts'

import type { ShowcaseListResponse } from '@mf/models'

/** The public demo gallery — `GET /bff/showcases` needs no session (wave 14, F3) */
export const showcasesApiSlice = appApi.injectEndpoints({
	endpoints: build => ({
		getShowcases: build.query<ShowcaseListResponse, void>({
			query: () => '/showcases',
		}),
	}),
})

export const { useGetShowcasesQuery } = showcasesApiSlice

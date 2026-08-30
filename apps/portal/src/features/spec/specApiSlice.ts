import { ApiCaching, appApi } from '#/app/api.ts'

import type { SpecDraft, SpecMutation } from '@mf/models'

export const specApiSlice = appApi.enhanceEndpoints({ addTagTypes: ['spec'] }).injectEndpoints({
	endpoints: build => ({
		getSpec: build.query<SpecDraft, string>({
			query: orderId => `/orders/${orderId}/spec`,
			providesTags: (_result, _error, orderId) => [{ type: 'spec', id: orderId }],
			keepUnusedDataFor: ApiCaching.none,
		}),
		postSpecMessage: build.mutation<
			SpecDraft,
			{ orderId: string } & SpecMutation['PostSpecMessage']
		>({
			query: ({ orderId, ...body }) => ({ url: `/orders/${orderId}/spec`, method: 'POST', body }),
			async onQueryStarted({ orderId }, { dispatch, queryFulfilled }) {
				// The response is the full draft — write it straight into the cache, no refetch
				const { data } = await queryFulfilled
				dispatch(specApiSlice.util.upsertQueryData('getSpec', orderId, data))
			},
		}),
		freezeSpec: build.mutation<SpecDraft, string>({
			query: orderId => ({ url: `/orders/${orderId}/spec/freeze`, method: 'POST' }),
			async onQueryStarted(orderId, { dispatch, queryFulfilled }) {
				const { data } = await queryFulfilled
				dispatch(specApiSlice.util.upsertQueryData('getSpec', orderId, data))
			},
		}),
	}),
})

export const { useGetSpecQuery, usePostSpecMessageMutation, useFreezeSpecMutation } = specApiSlice

import { appApi } from '#/app/api.ts'

import type { Item, ItemMutation, ItemQuery } from '@mf/models'

export const itemsApiSlice = appApi.enhanceEndpoints({ addTagTypes: ['items'] }).injectEndpoints({
	endpoints: build => ({
		getItems: build.query<Item[], ItemQuery['GetItems']>({
			query: params => ({ url: '/items', params }),
			providesTags: result => [
				'items',
				...(result ?? []).map(item => ({ type: 'items' as const, id: item.id })),
			],
		}),
		getItem: build.query<Item, string>({
			query: id => `/items/${id}`,
			providesTags: (_result, _error, id) => [{ type: 'items', id }],
		}),
		createItem: build.mutation<{ id: string }, ItemMutation['CreateItem']>({
			query: body => ({ url: '/items', method: 'POST', body }),
			invalidatesTags: ['items'],
		}),
		updateItem: build.mutation<void, { id: string } & ItemMutation['UpdateItem']>({
			query: ({ id, ...body }) => ({ url: `/items/${id}`, method: 'PATCH', body }),
			invalidatesTags: (_result, _error, { id }) => [{ type: 'items', id }],
		}),
	}),
})

export const { useGetItemsQuery, useGetItemQuery, useCreateItemMutation, useUpdateItemMutation } =
	itemsApiSlice

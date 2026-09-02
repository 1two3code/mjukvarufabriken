import { ApiCaching, appApi } from '#/app/api.ts'

import type { CreateQuoteResponse, Quote, QuoteMutation } from '@mf/models'
import type { QuoteHandle } from '#/features/quote/quoteStorage.ts'

/** The quote token travels as a header, never in the URL, on every call after `createQuote` */
const tokenHeader = (token: string) => ({ 'x-quote-token': token })

export const quoteApiSlice = appApi.enhanceEndpoints({ addTagTypes: ['quote'] }).injectEndpoints({
	endpoints: build => ({
		getQuote: build.query<Quote, QuoteHandle>({
			query: ({ orderId, token }) => ({ url: `/quote/${orderId}`, headers: tokenHeader(token) }),
			providesTags: (_result, _error, { orderId }) => [{ type: 'quote', id: orderId }],
			keepUnusedDataFor: ApiCaching.none,
		}),
		createQuote: build.mutation<CreateQuoteResponse, QuoteMutation['CreateQuote']>({
			query: body => ({ url: '/quote', method: 'POST', body }),
			async onQueryStarted(_body, { dispatch, queryFulfilled }) {
				// Seed the cache so the page has its (empty) draft without a second round trip
				const { data } = await queryFulfilled
				const handle = { orderId: data.quote.orderId, token: data.token }
				dispatch(quoteApiSlice.util.upsertQueryData('getQuote', handle, data.quote))
			},
		}),
		postQuoteMessage: build.mutation<Quote, QuoteHandle & QuoteMutation['PostQuoteMessage']>({
			query: ({ orderId, token, ...body }) => ({
				url: `/quote/${orderId}/message`,
				method: 'POST',
				headers: tokenHeader(token),
				body,
			}),
			async onQueryStarted({ orderId, token }, { dispatch, queryFulfilled }) {
				// The response is the full quote — write it straight into the cache, no refetch
				const { data } = await queryFulfilled
				dispatch(quoteApiSlice.util.upsertQueryData('getQuote', { orderId, token }, data))
			},
		}),
	}),
})

export const { useGetQuoteQuery, useCreateQuoteMutation, usePostQuoteMessageMutation } =
	quoteApiSlice

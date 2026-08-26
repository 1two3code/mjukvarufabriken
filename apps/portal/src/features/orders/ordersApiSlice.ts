import { ApiCaching, appApi } from '#/app/api.ts'

import type {
	CheckoutResponse,
	Order,
	OrderDetail,
	OrderMutation,
	Payment,
	PaymentKind,
} from '@mf/models'

export const ordersApiSlice = appApi.enhanceEndpoints({ addTagTypes: ['order'] }).injectEndpoints({
	endpoints: build => ({
		getOrders: build.query<Order[], void>({
			query: () => '/orders',
			providesTags: result => [
				{ type: 'order', id: 'list' },
				...(result ?? []).map(order => ({ type: 'order' as const, id: order.id })),
			],
			keepUnusedDataFor: ApiCaching.none,
		}),
		getOrder: build.query<OrderDetail, string>({
			query: orderId => `/orders/${orderId}`,
			providesTags: (_result, _error, orderId) => [{ type: 'order', id: orderId }],
			keepUnusedDataFor: ApiCaching.none,
		}),
		createOrder: build.mutation<Order, OrderMutation['CreateOrder']>({
			query: body => ({ url: '/orders', method: 'POST', body }),
			invalidatesTags: [{ type: 'order', id: 'list' }],
		}),
		cancelOrder: build.mutation<Order, string>({
			query: orderId => ({ url: `/orders/${orderId}/cancel`, method: 'POST' }),
			invalidatesTags: (_result, _error, orderId) => [
				{ type: 'order', id: orderId },
				{ type: 'order', id: 'list' },
			],
		}),
		/** Returns the Checkout url; the caller sends the browser there */
		createCheckout: build.mutation<CheckoutResponse, { orderId: string; kind: PaymentKind }>({
			query: ({ orderId, kind }) => ({
				url: `/orders/${orderId}/checkout`,
				method: 'POST',
				body: { kind },
			}),
		}),
		/** Fake provider only: "pays" the session in place of Stripe's Checkout page (dev/test) */
		completeFakeCheckout: build.mutation<Payment, { orderId: string; sessionId: string }>({
			query: ({ sessionId }) => ({ url: `/stripe/fake/checkout/${sessionId}`, method: 'POST' }),
			invalidatesTags: (_result, _error, { orderId }) => [
				{ type: 'order', id: orderId },
				{ type: 'order', id: 'list' },
			],
		}),
	}),
})

export const {
	useGetOrdersQuery,
	useGetOrderQuery,
	useCreateOrderMutation,
	useCancelOrderMutation,
	useCreateCheckoutMutation,
	useCompleteFakeCheckoutMutation,
} = ordersApiSlice

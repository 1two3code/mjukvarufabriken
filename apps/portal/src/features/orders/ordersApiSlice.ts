import { ApiCaching, appApi } from '#/app/api.ts'

import type {
	CheckoutResponse,
	Order,
	OrderDetail,
	OrderExportResponse,
	OrderMutation,
	Payment,
	PaymentKind,
	QuoteMutation,
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
		/** The final export before / after the hosting window ends (wave 14): 404 until one exists */
		getOrderExport: build.query<OrderExportResponse, string>({
			query: orderId => `/orders/${orderId}/export`,
			providesTags: (_result, _error, orderId) => [{ type: 'order', id: `${orderId}/export` }],
			// Presigned links live 15 minutes; refetch on every mount rather than serve a dead link
			keepUnusedDataFor: ApiCaching.none,
		}),
		createOrder: build.mutation<Order, OrderMutation['CreateOrder']>({
			query: body => ({ url: '/orders', method: 'POST', body }),
			invalidatesTags: [{ type: 'order', id: 'list' }],
		}),
		/** Claims an anonymous quote from the site for the session's org (wave 14, F1) */
		claimOrder: build.mutation<Order, QuoteMutation['ClaimQuote']>({
			query: body => ({ url: '/orders/claim', method: 'POST', body }),
			invalidatesTags: [{ type: 'order', id: 'list' }],
		}),
		cancelOrder: build.mutation<Order, string>({
			query: orderId => ({ url: `/orders/${orderId}/cancel`, method: 'POST' }),
			invalidatesTags: (_result, _error, orderId) => [
				{ type: 'order', id: orderId },
				{ type: 'order', id: 'list' },
			],
		}),
		/** Approve-before-deliver gate (W7): approve an awaiting_approval order → it delivers */
		approveOrder: build.mutation<Order, string>({
			query: orderId => ({ url: `/orders/${orderId}/approve`, method: 'POST' }),
			invalidatesTags: (_result, _error, orderId) => [
				{ type: 'order', id: orderId },
				{ type: 'order', id: 'list' },
			],
		}),
		/** Admin toggle of the per-order approve-before-deliver gate */
		setApprovalGate: build.mutation<Order, { orderId: string; enabled: boolean }>({
			query: ({ orderId, enabled }) => ({
				url: `/orders/${orderId}/approval-gate`,
				method: 'PATCH',
				body: { enabled },
			}),
			invalidatesTags: (_result, _error, { orderId }) => [{ type: 'order', id: orderId }],
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
	useGetOrderExportQuery,
	useCreateOrderMutation,
	useClaimOrderMutation,
	useCancelOrderMutation,
	useApproveOrderMutation,
	useSetApprovalGateMutation,
	useCreateCheckoutMutation,
	useCompleteFakeCheckoutMutation,
} = ordersApiSlice

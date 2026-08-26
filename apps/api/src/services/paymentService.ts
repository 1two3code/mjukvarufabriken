import fp from 'fastify-plugin'
import { paymentAmounts } from '@mf/models'

import { EntityInvalid, EntityNotFound } from '#/lib/entityError.ts'
import { InvalidWebhookSignature } from '#/plugins/stripe.ts'

import type { FastifyPluginAsync } from 'fastify'
import type {
	BackendSession,
	CheckoutResponse,
	OrderStatus,
	Payment,
	PaymentKind,
	PaymentProvider,
} from '@mf/models'
import type { PaymentEvent } from '#/plugins/stripe.ts'

declare module 'fastify' {
	interface FastifyInstance {
		paymentService: {
			/**
			 * Creates a pending payment for the order and a Checkout session for it. The deposit
			 * needs a frozen order, the balance a delivered one; a kind already paid is rejected.
			 */
			checkout: (
				orderId: string,
				kind: PaymentKind,
				session: BackendSession
			) => Promise<CheckoutResponse>
			/**
			 * Verifies and applies one webhook delivery: idempotent on the event id, marks the
			 * session's payment paid, moves the order on and, for the deposit, starts the build.
			 */
			handleWebhook: (rawBody: string, signature: string | undefined) => Promise<WebhookResult>
			/**
			 * The fake provider's "payment": marks the session paid the same way a webhook would.
			 * Rejects unless the fake provider is active.
			 */
			completeFakeSession: (sessionId: string) => Promise<Payment>
			/** The provider in use, so the portal can label the fake one */
			provider: PaymentProvider
		}
	}
}

export type WebhookResult = {
	eventId: string
	/** `applied` = payment marked paid now; `duplicate` = seen before; `ignored` = other event */
	outcome: 'applied' | 'duplicate' | 'ignored'
	payment?: Payment
}

/** The order is not in the status the payment kind requires (or the kind is already paid) */
export class PaymentNotDue extends EntityInvalid {
	constructor(orderId: string, kind: PaymentKind) {
		super('payment', `${orderId}/${kind}`)
	}
}

/** Only the fake provider has a local checkout page */
export class FakeProviderInactive extends EntityInvalid {
	constructor() {
		super('payment', 'fake')
	}
}

export { InvalidWebhookSignature }

/** Order status a payment of each kind requires, and the status it moves the order to */
export const paymentFlow: Record<PaymentKind, { from: OrderStatus; to: OrderStatus }> = {
	deposit: { from: 'frozen', to: 'deposit_paid' },
	balance: { from: 'delivered', to: 'paid' },
}

/** System session the webhook uses to start the build on the customer's behalf */
const webhookSession = (orgId: string): BackendSession => ({
	userId: 'stripe-webhook',
	role: 'admin',
	orgId,
})

const plugin: FastifyPluginAsync = async app => {
	const { db, paymentProvider, orderService, jobService, userService, secrets } = app

	const orderPageUrl = (orderId: string) => `${secrets.portalUrl}/orders/${orderId}`

	const customerEmail = async (session: BackendSession) => {
		try {
			return (await userService.get(session.userId)).email
		} catch {
			return undefined
		}
	}

	/**
	 * Marks the session's payment paid and moves the order on. Returns the payment, or undefined
	 * when the session is unknown / already paid (a redelivery of an applied event).
	 */
	const applyCompletedSession = async (sessionId: string, eventId: string) => {
		const pending = await db.orders.findPaymentBySession(sessionId)
		if (!pending || pending.status === 'paid') return undefined

		const receipts = await paymentProvider.getSessionReceipts(sessionId).catch(error => {
			app.log.warn({ err: error, sessionId }, 'Could not fetch the invoice/receipt urls')
			return {}
		})
		const payment = await db.orders.markPaymentPaid(pending.id, { eventId, ...receipts })
		if (!payment) return undefined

		const { to } = paymentFlow[payment.kind]
		try {
			await orderService.transition(payment.orderId, to)
		} catch (error) {
			// The money is in either way; a stale order status is an admin follow-up, not a retry
			app.log.error({ err: error, orderId: payment.orderId }, `Paid but could not move to ${to}`)
			return payment
		}
		if (payment.kind === 'deposit') await startBuild(payment.orderId)
		return payment
	}

	/** Deposit paid → the build starts on its own */
	const startBuild = async (orderId: string) => {
		const order = await db.orders.getOrder(orderId)
		if (!order) return
		try {
			await jobService.start(orderId, webhookSession(order.orgId))
			await orderService.transition(orderId, 'building')
		} catch (error) {
			app.log.error({ err: error, orderId }, 'Deposit paid but the build could not be started')
		}
	}

	const handleEvent = async (event: PaymentEvent): Promise<WebhookResult> => {
		const fresh = await db.orders.recordPaymentEvent(event.id, event.type)
		if (!fresh) return { eventId: event.id, outcome: 'duplicate' }
		if (event.type !== 'checkout.session.completed' || !event.sessionId) {
			return { eventId: event.id, outcome: 'ignored' }
		}
		const payment = await applyCompletedSession(event.sessionId, event.id)
		return { eventId: event.id, outcome: payment ? 'applied' : 'duplicate', payment }
	}

	app.decorate('paymentService', {
		provider: paymentProvider.kind,
		checkout: async (orderId, kind, session) => {
			const order = await orderService.get(orderId, session)
			if (order.status !== paymentFlow[kind].from || order.priceSek === undefined) {
				throw new PaymentNotDue(orderId, kind)
			}
			const existing = await db.orders.listPayments(orderId)
			if (existing.some(payment => payment.kind === kind && payment.status === 'paid')) {
				throw new PaymentNotDue(orderId, kind)
			}

			const amounts = paymentAmounts(order.priceSek, kind)
			const paymentId = crypto.randomUUID()
			const checkout = await paymentProvider.createCheckoutSession({
				paymentId,
				orderId,
				orderName: order.name || orderId,
				kind,
				amountSek: amounts.amountSek,
				vatSek: amounts.vatSek,
				customerEmail: await customerEmail(session),
				successUrl: `${orderPageUrl(orderId)}?payment=success&kind=${kind}`,
				cancelUrl: `${orderPageUrl(orderId)}?payment=cancelled&kind=${kind}`,
			})
			const payment = await db.orders.insertPayment({
				orderId,
				kind,
				provider: paymentProvider.kind,
				...amounts,
				sessionId: checkout.sessionId,
			})
			return { payment, url: checkout.url }
		},
		handleWebhook: async (rawBody, signature) =>
			handleEvent(paymentProvider.constructWebhookEvent(rawBody, signature)),
		completeFakeSession: async sessionId => {
			if (paymentProvider.kind !== 'fake') throw new FakeProviderInactive()
			const pending = await db.orders.findPaymentBySession(sessionId)
			if (!pending) throw new EntityNotFound('payment', sessionId)
			const result = await handleEvent({
				id: `evt_fake_${sessionId}`,
				type: 'checkout.session.completed',
				sessionId,
			})
			return result.payment ?? pending
		},
	})
}

export default fp(plugin, {
	name: '#internal/paymentService',
	dependencies: [
		'#internal/db',
		'#internal/stripe',
		'#internal/secrets',
		'#internal/orderService',
		'#internal/jobService',
		'#internal/userService',
	],
})

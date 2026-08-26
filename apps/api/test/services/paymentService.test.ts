import { EntityNotFound } from '#/lib/entityError.ts'
import { createMockJob } from '#/plugins/__mocks__/db.ts'
import { createMockPaymentEvent, mockSessionId } from '#/plugins/__mocks__/stripe.ts'
import { InvalidOrderTransition } from '#/services/orderService.ts'
import { FakeProviderInactive, PaymentNotDue } from '#/services/paymentService.ts'

import type { FastifyInstance } from 'fastify'
import type { BackendSession, Order, OrderStatus } from '@mf/models'

const user: BackendSession = { userId: 'user-1', role: 'user', orgId: 'org-1' }

/** Runs the real order service too, so the state machine is exercised end to end */
const createApp = () =>
	createTestApp({ skipMock: ['#/services/paymentService.ts', '#/services/orderService.ts'] })

describe('Payment Service', () => {
	let app: FastifyInstance

	const createOrder = async (status: OrderStatus, priceSek = 15_000): Promise<Order> => {
		const order = await app.orderService.create('Gym booking', user)
		const draft = (await app.db.orders.get(order.id))!
		await app.db.orders.upsert({ ...draft, status: 'frozen', priceSek })
		const path: OrderStatus[] = ['deposit_paid', 'building', 'delivered', 'paid']
		for (const step of path.slice(0, path.indexOf(status) + 1)) {
			await app.orderService.transition(order.id, step)
		}
		return app.orderService.get(order.id, user)
	}

	beforeEach(async () => {
		app = await createApp()
		vi.spyOn(app.db.jobs, 'list').mockResolvedValue([])
	})

	describe('checkout', () => {
		it('Creates a Checkout session for 50 % of the price with moms as its own line', async () => {
			const order = await createOrder('frozen')

			const result = await app.paymentService.checkout(order.id, 'deposit', user)

			expect(app.paymentProvider.createCheckoutSession).toHaveBeenCalledWith({
				paymentId: expect.any(String),
				orderId: order.id,
				orderName: 'Gym booking',
				kind: 'deposit',
				amountSek: 7_500,
				vatSek: 1_875,
				customerEmail: 'farnsworth@planetexpress.example',
				successUrl: `https://portal.example.com/orders/${order.id}?payment=success&kind=deposit`,
				cancelUrl: `https://portal.example.com/orders/${order.id}?payment=cancelled&kind=deposit`,
			})
			expect(result.url).toBe('https://checkout.stripe.com/c/pay/cs_test_123')
			expect(result.payment).toMatchObject({
				orderId: order.id,
				kind: 'deposit',
				status: 'pending',
				provider: 'stripe',
				amountSek: 7_500,
				vatSek: 1_875,
				totalSek: 9_375,
				sessionId: mockSessionId,
			})
			await expect(app.db.orders.listPayments(order.id)).resolves.toHaveLength(1)
		})

		it('Only allows the deposit on a frozen order and the balance on a delivered one', async () => {
			const drafting = await app.orderService.create('x', user)
			await expect(
				app.paymentService.checkout(drafting.id, 'deposit', user)
			).rejects.toBeInstanceOf(PaymentNotDue)

			const frozen = await createOrder('frozen')
			await expect(app.paymentService.checkout(frozen.id, 'balance', user)).rejects.toBeInstanceOf(
				PaymentNotDue
			)

			const delivered = await createOrder('delivered')
			await expect(
				app.paymentService.checkout(delivered.id, 'balance', user)
			).resolves.toMatchObject({ payment: { kind: 'balance' } })
		})

		it("Rejects a frozen order without a price and another org's order", async () => {
			const order = await app.orderService.create('x', user)
			await app.orderService.transition(order.id, 'ready')
			await app.orderService.transition(order.id, 'frozen')
			await expect(app.paymentService.checkout(order.id, 'deposit', user)).rejects.toBeInstanceOf(
				PaymentNotDue
			)
			await expect(
				app.paymentService.checkout(order.id, 'deposit', { ...user, orgId: 'org-2' })
			).rejects.toBeInstanceOf(EntityNotFound)
		})
	})

	describe('handleWebhook', () => {
		const paidDeposit = async () => {
			const order = await createOrder('frozen')
			const { payment } = await app.paymentService.checkout(order.id, 'deposit', user)
			const result = await app.paymentService.handleWebhook('{}', 'sig')
			return { order, payment, result }
		}

		it('Verifies the signature, marks the deposit paid with the receipts and starts the build', async () => {
			const { order, payment, result } = await paidDeposit()

			expect(app.paymentProvider.constructWebhookEvent).toHaveBeenCalledWith('{}', 'sig')
			expect(result.outcome).toBe('applied')
			expect(result.payment).toMatchObject({
				id: payment.id,
				status: 'paid',
				eventId: 'evt_1',
				hostedInvoiceUrl: 'https://invoice.stripe.com/i/inv_1',
				receiptUrl: 'https://pay.stripe.com/receipts/r_1',
				paidAt: expect.any(String),
			})
			expect(app.jobService.start).toHaveBeenCalledWith(order.id, {
				userId: 'stripe-webhook',
				role: 'admin',
				orgId: 'org-1',
			})
			await expect(app.orderService.get(order.id, user)).resolves.toMatchObject({
				status: 'building',
			})
		})

		it('Is idempotent on the event id and on the session', async () => {
			const { result } = await paidDeposit()
			expect(result.outcome).toBe('applied')

			// Same event redelivered
			await expect(app.paymentService.handleWebhook('{}', 'sig')).resolves.toMatchObject({
				outcome: 'duplicate',
			})
			// A different event for the same (already paid) session
			vi.mocked(app.paymentProvider.constructWebhookEvent).mockReturnValueOnce(
				createMockPaymentEvent({ id: 'evt_2' })
			)
			await expect(app.paymentService.handleWebhook('{}', 'sig')).resolves.toMatchObject({
				outcome: 'duplicate',
			})
			expect(app.jobService.start).toHaveBeenCalledTimes(1)
		})

		it('Ignores other event types and unknown sessions', async () => {
			vi.mocked(app.paymentProvider.constructWebhookEvent).mockReturnValueOnce(
				createMockPaymentEvent({
					id: 'evt_3',
					type: 'payment_intent.created',
					sessionId: undefined,
				})
			)
			await expect(app.paymentService.handleWebhook('{}', 'sig')).resolves.toEqual({
				eventId: 'evt_3',
				outcome: 'ignored',
			})

			vi.mocked(app.paymentProvider.constructWebhookEvent).mockReturnValueOnce(
				createMockPaymentEvent({ id: 'evt_4', sessionId: 'cs_unknown' })
			)
			await expect(app.paymentService.handleWebhook('{}', 'sig')).resolves.toEqual({
				eventId: 'evt_4',
				outcome: 'duplicate',
				payment: undefined,
			})
		})

		it('Keeps the payment paid when the order cannot move on or the build cannot start', async () => {
			const order = await createOrder('frozen')
			await app.paymentService.checkout(order.id, 'deposit', user)
			vi.spyOn(app.jobService, 'start').mockRejectedValueOnce(new Error('ECS down'))

			const result = await app.paymentService.handleWebhook('{}', 'sig')

			expect(result.payment?.status).toBe('paid')
			await expect(app.orderService.get(order.id, user)).resolves.toMatchObject({
				status: 'deposit_paid',
			})

			// Order moved on meanwhile: the transition is rejected, the payment stays paid
			const second = await createOrder('frozen')
			const { payment } = await app.paymentService.checkout(second.id, 'deposit', user)
			vi.mocked(app.paymentProvider.constructWebhookEvent).mockReturnValueOnce(
				createMockPaymentEvent({ id: 'evt_9', sessionId: payment.sessionId })
			)
			vi.spyOn(app.orderService, 'transition').mockRejectedValueOnce(
				new InvalidOrderTransition(second.id, 'cancelled', 'deposit_paid')
			)
			await expect(app.paymentService.handleWebhook('{}', 'sig')).resolves.toMatchObject({
				outcome: 'applied',
				payment: { status: 'paid' },
			})
		})

		it('Marks the balance paid and closes the order', async () => {
			const order = await createOrder('delivered')
			vi.spyOn(app.db.jobs, 'list').mockResolvedValue([
				createMockJob({ orderId: order.id, status: 'delivered' }),
			])
			const { payment } = await app.paymentService.checkout(order.id, 'balance', user)
			vi.mocked(app.paymentProvider.constructWebhookEvent).mockReturnValueOnce(
				createMockPaymentEvent({ id: 'evt_b', sessionId: payment.sessionId })
			)

			await app.paymentService.handleWebhook('{}', 'sig')

			await expect(app.orderService.get(order.id, user)).resolves.toMatchObject({ status: 'paid' })
			expect(app.jobService.start).not.toHaveBeenCalled()
		})

		it('Falls back to no receipt urls when Stripe cannot be reached', async () => {
			vi.mocked(app.paymentProvider.getSessionReceipts).mockRejectedValueOnce(new Error('down'))
			const { result } = await paidDeposit()
			expect(result.payment?.status).toBe('paid')
			expect(result.payment?.hostedInvoiceUrl).toBeUndefined()
			expect(result.payment?.receiptUrl).toBeUndefined()
		})
	})

	describe('completeFakeSession', () => {
		it('Rejects when Stripe is the active provider', async () => {
			await expect(app.paymentService.completeFakeSession('fake_x')).rejects.toBeInstanceOf(
				FakeProviderInactive
			)
		})

		it('Marks the fake session paid like a webhook would', async () => {
			// The real stripe plugin without a key decorates the fake provider
			vi.stubEnv('STRIPE_SECRET_KEY', '')
			vi.stubEnv('STRIPE_SECRET_KEY_SECRET_ARN', '')
			vi.doUnmock('#/plugins/stripe.ts')
			vi.resetModules()
			app = await createTestApp({
				skipMock: [
					'#/services/paymentService.ts',
					'#/services/orderService.ts',
					'#/plugins/stripe.ts',
				],
			})
			vi.spyOn(app.db.jobs, 'list').mockResolvedValue([])
			expect(app.paymentService.provider).toBe('fake')

			const order = await createOrder('frozen')
			const { payment, url } = await app.paymentService.checkout(order.id, 'deposit', user)
			expect(url).toBe(`https://api.example.com/bff/stripe/fake/checkout/${payment.sessionId}`)
			expect(payment.provider).toBe('fake')

			const paid = await app.paymentService.completeFakeSession(payment.sessionId)

			expect(paid).toMatchObject({ id: payment.id, status: 'paid' })
			expect(app.jobService.start).toHaveBeenCalledWith(order.id, expect.anything())
			await expect(app.orderService.get(order.id, user)).resolves.toMatchObject({
				status: 'building',
			})
			// Second visit of the same page: nothing happens, the paid payment is returned
			await expect(
				app.paymentService.completeFakeSession(payment.sessionId)
			).resolves.toMatchObject({ status: 'paid' })
			await expect(app.paymentService.completeFakeSession('fake_nope')).rejects.toThrow(/not found/)
			vi.unstubAllEnvs()
		})
	})
})

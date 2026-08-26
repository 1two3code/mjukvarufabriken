import Stripe from 'stripe'

import { createFakeProvider } from '#/plugins/stripe.ts'

import type { FastifyInstance } from 'fastify'
import type { CheckoutInput } from '#/plugins/stripe.ts'

const webhookSecret = 'whsec_test_secret'

const checkoutInput: CheckoutInput = {
	paymentId: 'payment-1',
	orderId: 'order-1',
	orderName: 'Gym booking',
	kind: 'deposit',
	amountSek: 7_500,
	vatSek: 1_875,
	customerEmail: 'anna@example.com',
	successUrl: 'https://portal.example.com/orders/order-1?payment=success',
	cancelUrl: 'https://portal.example.com/orders/order-1?payment=cancelled',
}

const completedSessionEvent = (id: string, sessionId: string) =>
	JSON.stringify({
		id,
		object: 'event',
		type: 'checkout.session.completed',
		data: { object: { id: sessionId, object: 'checkout.session' } },
	})

const createApp = async (env: Record<string, string>) => {
	vi.stubEnv('AUTH_AUDIENCE', 'audience')
	vi.stubEnv('ANTHROPIC_API_KEY', '')
	vi.stubEnv('ANTHROPIC_API_KEY_SECRET_ARN', '')
	vi.stubEnv('AUTH_JWT_PRIVATE_KEY_SECRET_ARN', '')
	vi.stubEnv('STRIPE_SECRET_KEY', '')
	vi.stubEnv('STRIPE_WEBHOOK_SECRET', '')
	vi.stubEnv('STRIPE_SECRET_KEY_SECRET_ARN', '')
	vi.stubEnv('STRIPE_WEBHOOK_SECRET_SECRET_ARN', '')
	for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
	vi.doUnmock('#/plugins/secrets.ts')
	vi.resetModules()
	return createTestApp({ skipMock: ['#/plugins/stripe.ts', '#/plugins/secrets.ts'] })
}

describe('Stripe plugin (paymentProvider)', () => {
	afterEach(() => {
		vi.unstubAllEnvs()
	})

	describe('fake provider (no STRIPE_SECRET_KEY)', () => {
		let app: FastifyInstance

		beforeEach(async () => {
			app = await createApp({})
		})

		it('Is selected when no key is configured and points checkout at the local fake page', async () => {
			expect(app.paymentProvider.kind).toBe('fake')

			const session = await app.paymentProvider.createCheckoutSession(checkoutInput)

			expect(session).toEqual({
				sessionId: 'fake_payment-1',
				url: 'http://localhost:5174/bff/stripe/fake/checkout/fake_payment-1',
			})
		})

		it('Accepts unsigned events with id and type and rejects anything else', () => {
			expect(
				app.paymentProvider.constructWebhookEvent(
					JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', sessionId: 'fake_1' }),
					undefined
				)
			).toEqual({ id: 'evt_1', type: 'checkout.session.completed', sessionId: 'fake_1' })
			expect(() => app.paymentProvider.constructWebhookEvent('{"id":"x"}', undefined)).toThrow(
				/Invalid webhook signature/
			)
		})

		it('Has no receipts and builds urls from the given api url', async () => {
			const provider = createFakeProvider('https://api.example.com')
			await expect(provider.getSessionReceipts('fake_1')).resolves.toEqual({})
			await expect(provider.createCheckoutSession(checkoutInput)).resolves.toMatchObject({
				url: 'https://api.example.com/bff/stripe/fake/checkout/fake_payment-1',
			})
		})
	})

	describe('stripe provider', () => {
		let app: FastifyInstance

		beforeEach(async () => {
			app = await createApp({
				STRIPE_SECRET_KEY: 'sk_test_123',
				STRIPE_WEBHOOK_SECRET: webhookSecret,
			})
		})

		it('Is selected when a key is configured', () => {
			expect(app.paymentProvider.kind).toBe('stripe')
		})

		it("Verifies a payload signed with Stripe's test signing helper", () => {
			// Arrange
			const payload = completedSessionEvent('evt_signed', 'cs_test_abc')
			const signature = Stripe.webhooks.generateTestHeaderString({
				payload,
				secret: webhookSecret,
			})

			// Act
			const event = app.paymentProvider.constructWebhookEvent(payload, signature)

			// Assert
			expect(event).toEqual({
				id: 'evt_signed',
				type: 'checkout.session.completed',
				sessionId: 'cs_test_abc',
			})
		})

		it('Rejects a tampered payload, a wrong secret and a missing header', () => {
			const payload = completedSessionEvent('evt_signed', 'cs_test_abc')
			const signature = Stripe.webhooks.generateTestHeaderString({
				payload,
				secret: webhookSecret,
			})
			const tampered = completedSessionEvent('evt_signed', 'cs_test_other')
			expect(() => app.paymentProvider.constructWebhookEvent(tampered, signature)).toThrow(
				/Invalid webhook signature/
			)

			const wrongSecret = Stripe.webhooks.generateTestHeaderString({
				payload,
				secret: 'whsec_wrong',
			})
			expect(() => app.paymentProvider.constructWebhookEvent(payload, wrongSecret)).toThrow(
				/Invalid webhook signature/
			)
			expect(() => app.paymentProvider.constructWebhookEvent(payload, undefined)).toThrow(
				/Invalid webhook signature/
			)
		})

		it('Leaves sessionId undefined for other event types', () => {
			const payload = JSON.stringify({
				id: 'evt_other',
				object: 'event',
				type: 'payment_intent.created',
				data: { object: { id: 'pi_1', object: 'payment_intent' } },
			})
			const signature = Stripe.webhooks.generateTestHeaderString({
				payload,
				secret: webhookSecret,
			})
			expect(app.paymentProvider.constructWebhookEvent(payload, signature)).toEqual({
				id: 'evt_other',
				type: 'payment_intent.created',
				sessionId: undefined,
			})
		})

		it('Creates a Checkout session with two SEK line items (net + 25 % moms)', async () => {
			// Arrange
			const mock = networkMock
				.post('https://api.stripe.com/v1/checkout/sessions')
				.reply(200, { id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' })

			// Act
			const session = await app.paymentProvider.createCheckoutSession(checkoutInput)

			// Assert
			expect(session).toEqual({
				sessionId: 'cs_test_1',
				url: 'https://checkout.stripe.com/c/pay/cs_test_1',
			})
			expect(mock.spy.called(1)).toBe(true)
			const body = new URLSearchParams(await mock.spy.requests[0]!.text())
			expect(body.get('mode')).toBe('payment')
			expect(body.get('line_items[0][price_data][unit_amount]')).toBe('750000')
			expect(body.get('line_items[0][price_data][currency]')).toBe('sek')
			expect(body.get('line_items[1][price_data][unit_amount]')).toBe('187500')
			expect(body.get('line_items[1][price_data][product_data][name]')).toContain('Moms 25 %')
			expect(body.get('client_reference_id')).toBe('payment-1')
			expect(body.get('metadata[orderId]')).toBe('order-1')
			expect(body.get('invoice_creation[enabled]')).toBe('true')
			expect(body.get('customer_email')).toBe('anna@example.com')
		})

		it('Reads the hosted invoice and receipt urls off the expanded session', async () => {
			networkMock.get('https://api.stripe.com/v1/checkout/sessions/cs_test_1').reply(200, {
				id: 'cs_test_1',
				invoice: { id: 'in_1', hosted_invoice_url: 'https://invoice.stripe.com/i/in_1' },
				payment_intent: {
					id: 'pi_1',
					latest_charge: { id: 'ch_1', receipt_url: 'https://pay.stripe.com/receipts/ch_1' },
				},
			})

			await expect(app.paymentProvider.getSessionReceipts('cs_test_1')).resolves.toEqual({
				hostedInvoiceUrl: 'https://invoice.stripe.com/i/in_1',
				receiptUrl: 'https://pay.stripe.com/receipts/ch_1',
			})
		})

		it('Rejects webhooks when no webhook secret is configured', async () => {
			const withoutSecret = await createApp({ STRIPE_SECRET_KEY: 'sk_test_123' })
			expect(() => withoutSecret.paymentProvider.constructWebhookEvent('{}', 'sig')).toThrow(
				/Invalid webhook signature/
			)
		})
	})
})

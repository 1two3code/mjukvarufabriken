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

const completedSessionEvent = (
	id: string,
	sessionId: string,
	type = 'checkout.session.completed',
	paymentStatus = 'paid'
) =>
	JSON.stringify({
		id,
		object: 'event',
		type,
		data: { object: { id: sessionId, object: 'checkout.session', payment_status: paymentStatus } },
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

		it('Keeps usage reports locally instead of billing anyone', async () => {
			const provider = createFakeProvider('https://api.example.com', 'local')
			const input = { installationId: 'acme-shop', month: '2026-09', usdCents: 5, identifier: 'i1' }

			await expect(provider.reportUsage(input)).resolves.toEqual({ reference: 'fake_usage_i1' })

			expect(provider.usageReports).toEqual([input])
		})

		it('Has no receipts and builds urls from the given api url', async () => {
			const provider = createFakeProvider('https://api.example.com', 'local')
			await expect(provider.getSessionReceipts('fake_1')).resolves.toEqual({})
			await expect(provider.expireSession('fake_1')).resolves.toBeUndefined()
			await expect(provider.createCheckoutSession(checkoutInput)).resolves.toMatchObject({
				url: 'https://api.example.com/bff/stripe/fake/checkout/fake_payment-1',
			})
		})

		it('Takes unsigned webhooks only on a developer machine, never in a deployed env', () => {
			const body = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' })
			for (const env of ['local', 'test']) {
				expect(
					createFakeProvider('http://x', env).constructWebhookEvent(body, undefined)
				).toMatchObject({ id: 'evt_1' })
			}
			for (const env of ['dev', 'live']) {
				expect(() =>
					createFakeProvider('http://x', env).constructWebhookEvent(body, undefined)
				).toThrow(/Invalid webhook signature/)
			}
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

		it('Only treats a completed session as paid when payment_status is paid', () => {
			// Delayed methods (bank transfer etc.) complete the session before the money is in
			const unpaid = completedSessionEvent(
				'evt_u',
				'cs_delayed',
				'checkout.session.completed',
				'unpaid'
			)
			const unpaidSignature = Stripe.webhooks.generateTestHeaderString({
				payload: unpaid,
				secret: webhookSecret,
			})
			expect(app.paymentProvider.constructWebhookEvent(unpaid, unpaidSignature)).toEqual({
				id: 'evt_u',
				type: 'checkout.session.completed',
				sessionId: undefined,
			})

			// ...and are paid on async_payment_succeeded
			const succeeded = completedSessionEvent(
				'evt_s',
				'cs_delayed',
				'checkout.session.async_payment_succeeded',
				'paid'
			)
			const succeededSignature = Stripe.webhooks.generateTestHeaderString({
				payload: succeeded,
				secret: webhookSecret,
			})
			expect(app.paymentProvider.constructWebhookEvent(succeeded, succeededSignature)).toEqual({
				id: 'evt_s',
				type: 'checkout.session.async_payment_succeeded',
				sessionId: 'cs_delayed',
			})
		})

		it('Expires an open Checkout session and leaves a closed one alone', async () => {
			// Arrange
			const openSession = networkMock
				.get('https://api.stripe.com/v1/checkout/sessions/cs_open')
				.reply(200, { id: 'cs_open', object: 'checkout.session', status: 'open' })
			const expire = networkMock
				.post('https://api.stripe.com/v1/checkout/sessions/cs_open/expire')
				.reply(200, { id: 'cs_open', object: 'checkout.session', status: 'expired' })
			const doneSession = networkMock
				.get('https://api.stripe.com/v1/checkout/sessions/cs_done')
				.reply(200, { id: 'cs_done', object: 'checkout.session', status: 'complete' })
			const expireDone = networkMock
				.post('https://api.stripe.com/v1/checkout/sessions/cs_done/expire')
				.reply(200, {})

			// Act
			await app.paymentProvider.expireSession('cs_open')
			await app.paymentProvider.expireSession('cs_done')

			// Assert
			expect(openSession.spy.called(1)).toBe(true)
			expect(expire.spy.called(1)).toBe(true)
			expect(doneSession.spy.called(1)).toBe(true)
			expect(expireDone.spy.called(0)).toBe(true)
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
			expect(body.get('billing_address_collection')).toBe('required')
			expect(body.get('managed_payments[enabled]')).toBe('false')
			expect(body.get('payment_method_types[0]')).toBe('card')
			expect(body.get('payment_method_types[1]')).toBe('klarna')
			expect(body.get('line_items[0][price_data][unit_amount]')).toBe('750000')
			expect(body.get('line_items[0][price_data][currency]')).toBe('sek')
			expect(body.get('line_items[1][price_data][unit_amount]')).toBe('187500')
			expect(body.get('line_items[1][price_data][product_data][name]')).toContain('Moms 25 %')
			expect(body.get('line_items[0][price_data][product_data][tax_code]')).toBe('txcd_10000000')
			expect(body.get('line_items[1][price_data][product_data][tax_code]')).toBe('txcd_10000000')
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

		it('Reports resident usage as a billing meter event in US cents', async () => {
			// Arrange
			const mock = networkMock
				.post('https://api.stripe.com/v1/billing/meter_events')
				.reply(200, { object: 'billing.meter_event', identifier: 'acme-shop/2026-09/1350' })

			// Act
			const report = await app.paymentProvider.reportUsage({
				installationId: 'acme-shop',
				month: '2026-09',
				customerId: 'cus_acme',
				usdCents: 1_350,
				identifier: 'acme-shop/2026-09/1350',
			})

			// Assert
			expect(report).toEqual({ reference: 'acme-shop/2026-09/1350' })
			expect(mock.spy.called(1)).toBe(true)
			const body = new URLSearchParams(await mock.spy.requests[0]!.text())
			expect(body.get('event_name')).toBe('resident_usage_usd_cents')
			expect(body.get('identifier')).toBe('acme-shop/2026-09/1350')
			expect(body.get('payload[stripe_customer_id]')).toBe('cus_acme')
			expect(body.get('payload[value]')).toBe('1350')
		})

		it('Refuses to report usage without a customer id', async () => {
			await expect(
				app.paymentProvider.reportUsage({
					installationId: 'acme-shop',
					month: '2026-09',
					usdCents: 1,
					identifier: 'x',
				})
			).rejects.toThrow(/no billing customer id/)
		})

		it('Rejects webhooks when no webhook secret is configured', async () => {
			const withoutSecret = await createApp({ STRIPE_SECRET_KEY: 'sk_test_123' })
			expect(() => withoutSecret.paymentProvider.constructWebhookEvent('{}', 'sig')).toThrow(
				/Invalid webhook signature/
			)
		})
	})

	describe('placeholder secrets (hardening audit 2026-08-30, E1)', () => {
		// The CDK placeholder for these secrets is a random 32-char string, never empty — a plain
		// `!secretKey` check can't distinguish it from a real key. A key without the `sk_` prefix
		// must be treated exactly like a missing one.
		const placeholderKey = 'aB3xY9qZ7wErTyUiOpAsDfGhJkLzXcVb'

		it('Falls back to the fake provider — not the real Stripe client — on a non-Stripe-shaped key', async () => {
			const app = await createApp({ STRIPE_SECRET_KEY: placeholderKey })
			expect(app.paymentProvider.kind).toBe('fake')
		})

		it('Throws in live on a non-Stripe-shaped key exactly as it would on a missing one', async () => {
			await expect(createApp({ ENV: 'live', STRIPE_SECRET_KEY: placeholderKey })).rejects.toThrow(
				/STRIPE_SECRET_KEY is required in live/
			)
		})

		it('Rejects webhooks when the configured webhook secret is not Stripe-shaped', async () => {
			const app = await createApp({
				STRIPE_SECRET_KEY: 'sk_test_123',
				STRIPE_WEBHOOK_SECRET: placeholderKey,
			})
			expect(() => app.paymentProvider.constructWebhookEvent('{}', 'sig')).toThrow(
				/Invalid webhook signature/
			)
		})
	})
})

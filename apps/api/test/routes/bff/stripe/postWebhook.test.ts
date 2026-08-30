import { InvalidWebhookSignature } from '#/plugins/stripe.ts'
import postWebhook from '#/routes/bff/stripe/postWebhook.ts'

import type { FastifyInstance } from 'fastify'

describe('POST /bff/stripe/webhook route', () => {
	let app: FastifyInstance

	const url = '/bff/stripe/webhook'
	const rawBody = '{"id":"evt_1","type":"checkout.session.completed"}'

	beforeEach(async () => {
		app = await createTestApp()
		app.register(postWebhook)
	})

	it('Passes the raw body and signature to the service and acknowledges', async () => {
		// Arrange
		// Act
		const response = await app.inject({
			method: 'POST',
			url,
			payload: rawBody,
			headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=abc' },
		})

		// Assert
		expect(app.paymentService.handleWebhook).toHaveBeenCalledWith(rawBody, 't=1,v1=abc')
		expect(response.statusCode).toBe(200)
		expect(response.json()).toEqual({ received: true, eventId: 'evt_1', outcome: 'applied' })
	})

	it('Is public: no bearer token needed', async () => {
		const response = await app.inject({
			method: 'POST',
			url,
			payload: rawBody,
			headers: { 'content-type': 'application/json' },
		})
		expect(response.statusCode).toBe(200)
		expect(app.paymentService.handleWebhook).toHaveBeenCalledWith(rawBody, undefined)
	})

	it('Responds 400 on an invalid signature', async () => {
		// Arrange
		vi.spyOn(app.paymentService, 'handleWebhook').mockRejectedValue(
			new InvalidWebhookSignature(new Error('bad'))
		)

		// Act
		const response = await app.inject({
			method: 'POST',
			url,
			payload: rawBody,
			headers: { 'content-type': 'application/json', 'stripe-signature': 'x' },
		})

		// Assert
		expect(response.statusCode).toBe(400)
	})

	it('Responds 500 so Stripe retries when applying the event fails', async () => {
		// Arrange
		vi.spyOn(app.paymentService, 'handleWebhook').mockRejectedValue(new Error('db down'))

		// Act
		const response = await app.inject({
			method: 'POST',
			url,
			payload: rawBody,
			headers: { 'content-type': 'application/json', 'stripe-signature': 'x' },
		})

		// Assert
		expect(response.statusCode).toBe(500)
	})
})

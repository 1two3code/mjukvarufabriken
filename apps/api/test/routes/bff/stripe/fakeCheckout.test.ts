import { EntityNotFound } from '#/lib/entityError.ts'
import fakeCheckout from '#/routes/bff/stripe/fakeCheckout.ts'
import { createMockPayment } from '#/services/__mocks__/paymentService.ts'
import { FakeProviderInactive } from '#/services/paymentService.ts'

import type { FastifyInstance } from 'fastify'

describe('GET /bff/stripe/fake/checkout/:sessionId route', () => {
	let app: FastifyInstance

	const url = '/bff/stripe/fake/checkout/fake_payment-1'

	beforeEach(async () => {
		app = await createTestApp()
		app.register(fakeCheckout)
	})

	it('Marks the fake session paid and redirects to the order page', async () => {
		// Arrange
		vi.spyOn(app.paymentService, 'completeFakeSession').mockResolvedValue(
			createMockPayment({ orderId: 'order-7', kind: 'deposit', status: 'paid' })
		)

		// Act
		const response = await app.inject({ url })

		// Assert
		expect(app.paymentService.completeFakeSession).toHaveBeenCalledWith('fake_payment-1')
		expect(response.statusCode).toBe(303)
		expect(response.headers.location).toBe(
			'https://portal.example.com/orders/order-7?payment=success&kind=deposit&fake=1'
		)
	})

	it('Is 404 when Stripe is the active provider or the session is unknown', async () => {
		vi.spyOn(app.paymentService, 'completeFakeSession').mockRejectedValueOnce(
			new FakeProviderInactive()
		)
		expect((await app.inject({ url })).statusCode).toBe(404)

		vi.spyOn(app.paymentService, 'completeFakeSession').mockRejectedValueOnce(
			new EntityNotFound('payment')
		)
		expect((await app.inject({ url })).statusCode).toBe(404)
	})

	it('Handles server error with 500 response', async () => {
		vi.spyOn(app.paymentService, 'completeFakeSession').mockRejectedValue(new Error('Fail'))
		expect((await app.inject({ url })).statusCode).toBe(500)
	})
})

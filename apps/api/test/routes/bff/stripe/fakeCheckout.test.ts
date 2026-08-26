import { EntityNotFound } from '#/lib/entityError.ts'
import fakeCheckout from '#/routes/bff/stripe/fakeCheckout.ts'
import { createMockPayment } from '#/services/__mocks__/paymentService.ts'
import { FakeProviderInactive } from '#/services/paymentService.ts'

import type { FastifyInstance } from 'fastify'

const session = { userId: 'user-1', role: 'user', orgId: 'org-1' }

describe('POST /bff/stripe/fake/checkout/:sessionId route', () => {
	let app: FastifyInstance

	const url = '/bff/stripe/fake/checkout/fake_payment-1'

	beforeEach(async () => {
		app = await createTestApp()
		app.register(fakeCheckout)
	})

	it('Marks the fake session paid for the caller’s org and returns the payment', async () => {
		// Arrange
		const payment = createMockPayment({
			orderId: 'order-7',
			kind: 'deposit',
			status: 'paid',
			provider: 'fake',
			sessionId: 'fake_payment-1',
		})
		vi.spyOn(app.paymentService, 'completeFakeSession').mockResolvedValue(payment)

		// Act
		const response = await app.inject({ method: 'POST', url })

		// Assert
		expect(app.paymentService.completeFakeSession).toHaveBeenCalledWith('fake_payment-1', session)
		expect(response.statusCode).toBe(200)
		expect(response.json()).toEqual(payment)
	})

	it('Is 404 when Stripe is the active provider or the session is unknown', async () => {
		vi.spyOn(app.paymentService, 'completeFakeSession').mockRejectedValueOnce(
			new FakeProviderInactive()
		)
		expect((await app.inject({ method: 'POST', url })).statusCode).toBe(404)

		vi.spyOn(app.paymentService, 'completeFakeSession').mockRejectedValueOnce(
			new EntityNotFound('payment')
		)
		expect((await app.inject({ method: 'POST', url })).statusCode).toBe(404)
	})

	it('Handles server error with 500 response', async () => {
		vi.spyOn(app.paymentService, 'completeFakeSession').mockRejectedValue(new Error('Fail'))
		expect((await app.inject({ method: 'POST', url })).statusCode).toBe(500)
	})
})

import { EntityNotFound } from '#/lib/entityError.ts'
import { mockCheckoutUrl } from '#/plugins/__mocks__/stripe.ts'
import createCheckout from '#/routes/bff/orders/checkout/createCheckout.ts'
import { createMockPayment } from '#/services/__mocks__/paymentService.ts'
import { BalanceAwaitsPreview, PaymentNotDue } from '#/services/paymentService.ts'

import type { FastifyInstance } from 'fastify'

const session = { userId: 'user-1', role: 'user', orgId: 'org-1' }

describe('POST /bff/orders/:orderId/checkout route', () => {
	let app: FastifyInstance

	const url = '/bff/orders/order-1/checkout'

	beforeEach(async () => {
		app = await createTestApp()
		app.register(createCheckout)
	})

	it('Creates a Checkout session and returns the payment + url with 201', async () => {
		// Arrange
		// Act
		const response = await app.inject({ method: 'POST', url, payload: { kind: 'deposit' } })

		// Assert
		expect(app.paymentService.checkout).toHaveBeenCalledWith('order-1', 'deposit', session)
		expect(response.statusCode).toBe(201)
		expect(response.json()).toEqual({
			payment: createMockPayment({ orderId: 'order-1', kind: 'deposit' }),
			url: mockCheckoutUrl,
		})
	})

	it('Validates the kind', async () => {
		const response = await app.inject({ method: 'POST', url, payload: { kind: 'tip' } })
		expect(response.statusCode).toBe(400)
		expect(app.paymentService.checkout).not.toHaveBeenCalled()
	})

	it('Responds 409 paymentNotDue when the order is not in the right status', async () => {
		// Arrange
		vi.spyOn(app.paymentService, 'checkout').mockRejectedValue(
			new PaymentNotDue('order-1', 'balance')
		)

		// Act
		const response = await app.inject({ method: 'POST', url, payload: { kind: 'balance' } })

		// Assert
		expect(response.statusCode).toBe(409)
		expect(response.json().error.code).toBe('paymentNotDue')
	})

	it('Responds 409 balanceAwaitsPreview when the delivered preview is down', async () => {
		// Arrange
		vi.spyOn(app.paymentService, 'checkout').mockRejectedValue(
			new BalanceAwaitsPreview('order-1')
		)

		// Act
		const response = await app.inject({ method: 'POST', url, payload: { kind: 'balance' } })

		// Assert
		expect(response.statusCode).toBe(409)
		expect(response.json().error.code).toBe('balanceAwaitsPreview')
	})

	it('Handles unknown order with 404 and other failures with 500', async () => {
		vi.spyOn(app.paymentService, 'checkout').mockRejectedValueOnce(new EntityNotFound('order'))
		expect(
			(await app.inject({ method: 'POST', url, payload: { kind: 'deposit' } })).statusCode
		).toBe(404)

		vi.spyOn(app.paymentService, 'checkout').mockRejectedValueOnce(new Error('Stripe down'))
		expect(
			(await app.inject({ method: 'POST', url, payload: { kind: 'deposit' } })).statusCode
		).toBe(500)
	})
})

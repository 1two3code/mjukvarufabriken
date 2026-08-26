import { EntityNotFound } from '#/lib/entityError.ts'
import cancelOrder from '#/routes/bff/orders/cancelOrder.ts'
import { InvalidOrderTransition } from '#/services/orderService.ts'

import type { FastifyInstance } from 'fastify'

const session = { userId: 'user-1', role: 'user', orgId: 'org-1' }

describe('POST /bff/orders/:orderId/cancel route', () => {
	let app: FastifyInstance

	const url = '/bff/orders/order-1/cancel'

	beforeEach(async () => {
		app = await createTestApp()
		app.register(cancelOrder)
	})

	it('Cancels the order', async () => {
		// Arrange
		// Act
		const response = await app.inject({ method: 'POST', url })

		// Assert
		expect(app.orderService.cancel).toHaveBeenCalledWith('order-1', session)
		expect(response.statusCode).toBe(200)
		expect(response.json()).toMatchObject({ id: 'order-1', status: 'cancelled' })
	})

	it('Responds 409 orderTransitionInvalid when the order cannot be cancelled', async () => {
		// Arrange
		vi.spyOn(app.orderService, 'cancel').mockRejectedValue(
			new InvalidOrderTransition('order-1', 'paid', 'cancelled')
		)

		// Act
		const response = await app.inject({ method: 'POST', url })

		// Assert
		expect(response.statusCode).toBe(409)
		expect(response.json().error.code).toBe('orderTransitionInvalid')
	})

	it('Handles unknown order with 404 and other failures with 500', async () => {
		vi.spyOn(app.orderService, 'cancel').mockRejectedValueOnce(new EntityNotFound('order'))
		expect((await app.inject({ method: 'POST', url })).statusCode).toBe(404)

		vi.spyOn(app.orderService, 'cancel').mockRejectedValueOnce(new Error('Fail'))
		expect((await app.inject({ method: 'POST', url })).statusCode).toBe(500)
	})
})

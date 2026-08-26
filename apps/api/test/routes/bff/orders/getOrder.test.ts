import { EntityNotFound } from '#/lib/entityError.ts'
import getOrder from '#/routes/bff/orders/getOrder.ts'
import { createMockOrderDetail } from '#/services/__mocks__/orderService.ts'

import type { FastifyInstance } from 'fastify'

const session = { userId: 'user-1', role: 'user', orgId: 'org-1' }

describe('GET /bff/orders/:orderId route', () => {
	let app: FastifyInstance

	const url = '/bff/orders/order-1'

	beforeEach(async () => {
		app = await createTestApp()
		app.register(getOrder)
	})

	it('Returns the order detail', async () => {
		// Arrange
		// Act
		const response = await app.inject({ url })

		// Assert
		expect(app.orderService.getDetail).toHaveBeenCalledWith('order-1', session)
		expect(response.statusCode).toBe(200)
		expect(response.json()).toEqual(createMockOrderDetail({ order: { id: 'order-1' } }))
	})

	it('Handles unknown order with 404 response', async () => {
		// Arrange
		vi.spyOn(app.orderService, 'getDetail').mockRejectedValue(new EntityNotFound('order'))

		// Act
		const response = await app.inject({ url })

		// Assert
		expect(response.statusCode).toBe(404)
	})

	it('Handles server error with 500 response', async () => {
		// Arrange
		vi.spyOn(app.orderService, 'getDetail').mockRejectedValue(new Error('Fail'))

		// Act
		const response = await app.inject({ url })

		// Assert
		expect(response.statusCode).toBe(500)
	})
})

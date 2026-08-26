import getOrders from '#/routes/bff/orders/getOrders.ts'
import { createMockOrder } from '#/services/__mocks__/orderService.ts'

import type { FastifyInstance } from 'fastify'

const session = { userId: 'user-1', role: 'user', orgId: 'org-1' }

describe('GET /bff/orders route', () => {
	let app: FastifyInstance

	const url = '/bff/orders'

	beforeEach(async () => {
		app = await createTestApp()
		app.register(getOrders)
	})

	it("Returns the org's orders", async () => {
		// Arrange
		// Act
		const response = await app.inject({ url })

		// Assert
		expect(app.orderService.list).toHaveBeenCalledWith(session)
		expect(response.statusCode).toBe(200)
		expect(response.json()).toEqual([createMockOrder()])
	})

	it('Handles server error with 500 response', async () => {
		// Arrange
		vi.spyOn(app.orderService, 'list').mockRejectedValue(new Error('Fail'))

		// Act
		const response = await app.inject({ url })

		// Assert
		expect(response.statusCode).toBe(500)
	})
})

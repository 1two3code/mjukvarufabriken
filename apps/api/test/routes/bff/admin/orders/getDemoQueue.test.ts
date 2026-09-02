import getDemoQueue from '#/routes/bff/admin/orders/getDemoQueue.ts'

import type { FastifyInstance } from 'fastify'

describe('GET /bff/admin/orders/demo-queue route', () => {
	let app: FastifyInstance

	const url = '/bff/admin/orders/demo-queue'

	beforeEach(async () => {
		app = await createTestApp()
		app.register(getDemoQueue)
	})

	it('Returns the waiting demos with the weekly cap state', async () => {
		// Act
		const response = await app.inject({ url })

		// Assert
		expect(app.orderService.demoQueue).toHaveBeenCalledTimes(1)
		expect(response.statusCode).toBe(200)
		expect(response.json()).toMatchObject({
			orders: [{ id: 'order-demo', kind: 'demo', status: 'deposit_paid' }],
			approvedThisWeek: 1,
			cap: 5,
		})
	})

	it('Handles server error with 500 response', async () => {
		// Arrange
		vi.spyOn(app.orderService, 'demoQueue').mockRejectedValue(new Error('Fail'))

		// Act
		const response = await app.inject({ url })

		// Assert
		expect(response.statusCode).toBe(500)
	})
})

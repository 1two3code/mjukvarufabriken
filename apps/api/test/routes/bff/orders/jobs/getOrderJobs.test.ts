import { createMockJob } from '#/plugins/__mocks__/db.ts'
import getOrderJobs from '#/routes/bff/orders/jobs/getOrderJobs.ts'

import type { FastifyInstance } from 'fastify'

const session = { userId: 'user-1', role: 'user', orgId: 'org-1' }

describe('GET /bff/orders/:orderId/jobs route', () => {
	let app: FastifyInstance

	const url = '/bff/orders/order-1/jobs'

	beforeEach(async () => {
		app = await createTestApp()
		app.register(getOrderJobs)
	})

	it('Returns the jobs of the order', async () => {
		// Arrange
		// Act
		const response = await app.inject({ url })

		// Assert
		expect(app.jobService.listForOrder).toHaveBeenCalledWith('order-1', session)
		expect(response.statusCode).toBe(200)
		expect(response.json()).toEqual([createMockJob({ orderId: 'order-1' })])
	})

	it('Handles server error with 500 response', async () => {
		// Arrange
		vi.spyOn(app.jobService, 'listForOrder').mockRejectedValue(new Error('Fail'))

		// Act
		const response = await app.inject({ url })

		// Assert
		expect(response.statusCode).toBe(500)
	})
})

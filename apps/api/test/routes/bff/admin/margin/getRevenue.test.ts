import getRevenue from '#/routes/bff/admin/margin/getRevenue.ts'
import { createMockCustomerRevenue } from '#/services/__mocks__/marginService.ts'

import type { FastifyInstance } from 'fastify'

describe('GET /bff/admin/margin/revenue route', () => {
	let app: FastifyInstance

	const url = '/bff/admin/margin/revenue'

	beforeEach(async () => {
		app = await createTestApp()
		app.register(getRevenue)
	})

	it('Returns per-customer revenue', async () => {
		// Arrange
		// Act
		const response = await app.inject({ url })

		// Assert
		expect(response.statusCode).toBe(200)
		expect(response.json()).toEqual([createMockCustomerRevenue()])
	})

	it('Handles server error with 500 response', async () => {
		// Arrange
		vi.spyOn(app.marginService, 'revenueByCustomer').mockRejectedValue(new Error('Fail'))

		// Act
		const response = await app.inject({ url })

		// Assert
		expect(response.statusCode).toBe(500)
	})
})

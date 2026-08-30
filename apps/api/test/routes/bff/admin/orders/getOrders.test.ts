import getOrders from '#/routes/bff/admin/orders/getOrders.ts'

import type { FastifyInstance } from 'fastify'

describe('GET /bff/admin/orders route', () => {
	let app: FastifyInstance

	const url = '/bff/admin/orders'

	beforeEach(async () => {
		app = await createTestApp()
		app.register(getOrders)
	})

	it('Returns every order across orgs', async () => {
		// Arrange
		await app.db.orders.insert({ id: 'o1', orgId: 'org-1', name: 'one' })
		await app.db.orders.insert({ id: 'o2', orgId: 'org-2', name: 'two' })

		// Act
		const response = await app.inject({ url })

		// Assert
		expect(response.statusCode).toBe(200)
		expect(
			response
				.json()
				.map((order: { id: string }) => order.id)
				.sort()
		).toEqual(['o1', 'o2'])
	})

	it('Handles server error with 500 response', async () => {
		// Arrange
		vi.spyOn(app.db.orders, 'listOrders').mockRejectedValue(new Error('Fail'))

		// Act
		const response = await app.inject({ url })

		// Assert
		expect(response.statusCode).toBe(500)
	})
})

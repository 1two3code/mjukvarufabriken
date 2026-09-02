import patchHostingUntil from '#/routes/bff/admin/orders/patchHostingUntil.ts'

import type { FastifyInstance } from 'fastify'

describe('PATCH /bff/admin/orders/:orderId/hosting-until route', () => {
	let app: FastifyInstance

	const url = '/bff/admin/orders/order-1/hosting-until'

	beforeEach(async () => {
		app = await createTestApp()
		app.register(patchHostingUntil)
		await app.db.orders.insert({ id: 'order-1', orgId: 'org-1', name: 'Acme gym' })
	})

	it('Sets the end of the hosting window', async () => {
		// Act
		const response = await app.inject({
			method: 'PATCH',
			url,
			payload: { hostingUntil: '2026-12-24T00:00:00.000Z' },
		})

		// Assert
		expect(response.statusCode).toBe(200)
		expect(response.json().hostingUntil).toBe('2026-12-24T00:00:00.000Z')
		expect((await app.db.orders.getOrder('order-1'))?.hostingUntil).toBe('2026-12-24T00:00:00.000Z')
	})

	it('Clears the window with null so the sweep never picks the order up', async () => {
		// Arrange
		await app.db.orders.setHostingUntil('order-1', new Date('2026-12-24T00:00:00.000Z'))

		// Act
		const response = await app.inject({ method: 'PATCH', url, payload: { hostingUntil: null } })

		// Assert
		expect(response.statusCode).toBe(200)
		expect(response.json().hostingUntil).toBeUndefined()
	})

	it('Rejects a non-datetime with 400 and an unknown order with 404', async () => {
		expect(
			(await app.inject({ method: 'PATCH', url, payload: { hostingUntil: 'tomorrow' } })).statusCode
		).toBe(400)
		expect(
			(
				await app.inject({
					method: 'PATCH',
					url: '/bff/admin/orders/order-nope/hosting-until',
					payload: { hostingUntil: null },
				})
			).statusCode
		).toBe(404)
	})
})

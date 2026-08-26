import getItems from '#/routes/bff/items/getItems.ts'
import { createMockItem } from '#/services/__mocks__/itemService.ts'

import type { FastifyInstance } from 'fastify'

describe('GET /bff/items route', () => {
	let app: FastifyInstance

	const url = '/bff/items'

	beforeEach(async () => {
		app = await createTestApp()
		app.register(getItems)
	})

	it('Handles server error with 500 response', async () => {
		// Arrange
		vi.spyOn(app.itemService, 'find').mockRejectedValue(new Error('Fail'))

		// Act
		const response = await app.inject({ url })

		// Assert
		expect(response.statusCode).toBe(500)
	})

	it('Rejects an invalid status filter with 400', async () => {
		// Arrange
		// Act
		const response = await app.inject({ url, query: { status: 'unknown' } })

		// Assert
		expect(response.statusCode).toBe(400)
	})

	it('Returns items sorted by newest first and forwards the filter', async () => {
		// Arrange
		const older = createMockItem({ id: 'old', createdAt: '2024-01-01T00:00:00.000Z' })
		const newer = createMockItem({ id: 'new', createdAt: '2025-01-01T00:00:00.000Z' })
		vi.spyOn(app.itemService, 'find').mockResolvedValue([older, newer])

		// Act
		const response = await app.inject({ url, query: { status: 'active', search: 'ship' } })

		// Assert
		expect(app.itemService.find).toHaveBeenCalledWith({ status: 'active', search: 'ship' })
		expect(response.statusCode).toBe(200)
		expect(response.json()).toEqual([newer, older])
	})
})

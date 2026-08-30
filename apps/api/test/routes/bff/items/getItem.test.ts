import { EntityNotFound } from '#/lib/entityError.ts'
import getItem from '#/routes/bff/items/getItem.ts'

import type { FastifyInstance } from 'fastify'
import type { Item } from '@template/models'

describe('GET /bff/items/:id route', () => {
	let app: FastifyInstance
	let item: Item

	const itemId = 'item-1'
	const url = `/bff/items/${itemId}`

	beforeEach(async () => {
		app = await createTestApp()
		app.register(getItem)

		item = await app.itemService.get(itemId)
	})

	it('Handles unknown id with 404 response', async () => {
		// Arrange
		vi.spyOn(app.itemService, 'get').mockRejectedValueOnce(new EntityNotFound('item'))

		// Act
		const response = await app.inject({ url })

		// Assert
		expect(response.statusCode).toBe(404)
	})

	it('Handles server error with 500 response', async () => {
		// Arrange
		vi.spyOn(app.itemService, 'get').mockRejectedValue(new Error('Fail'))

		// Act
		const response = await app.inject({ url })

		// Assert
		expect(response.statusCode).toBe(500)
	})

	it('Returns the item by id', async () => {
		// Arrange
		vi.spyOn(app.itemService, 'get').mockResolvedValue(item)

		// Act
		const response = await app.inject({ url })

		// Assert
		expect(app.itemService.get).toHaveBeenCalledWith(itemId)
		expect(response.statusCode).toBe(200)
		expect(response.json()).toEqual(item)
	})
})

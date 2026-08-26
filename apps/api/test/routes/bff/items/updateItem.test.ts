import { EntityNotFound } from '#/lib/entityError.ts'
import updateItem from '#/routes/bff/items/updateItem.ts'

import type { FastifyInstance } from 'fastify'
import type { ItemMutation } from '@mf/models'

describe('PATCH /bff/items/:id route', () => {
	let app: FastifyInstance

	const itemId = 'item-1'
	const url = `/bff/items/${itemId}`
	const payload: ItemMutation['UpdateItem'] = { name: 'Renamed', status: 'archived' }

	beforeEach(async () => {
		app = await createTestApp()
		app.register(updateItem)
	})

	it('Rejects unknown properties with 400', async () => {
		// Arrange
		// Act
		const response = await app.inject({ method: 'PATCH', url, payload: { id: 'other' } })

		// Assert
		expect(response.statusCode).toBe(400)
	})

	it('Handles unknown id with 404 response', async () => {
		// Arrange
		vi.spyOn(app.itemService, 'update').mockRejectedValueOnce(new EntityNotFound('item', itemId))

		// Act
		const response = await app.inject({ method: 'PATCH', url, payload })

		// Assert
		expect(response.statusCode).toBe(404)
	})

	it('Handles server error with 500 response and an error code', async () => {
		// Arrange
		vi.spyOn(app.itemService, 'update').mockRejectedValue(new Error('Fail'))

		// Act
		const response = await app.inject({ method: 'PATCH', url, payload })

		// Assert
		expect(response.statusCode).toBe(500)
		expect(response.json().error.code).toBe('failedToUpdateItem')
	})

	it('Updates the item and responds with 204', async () => {
		// Arrange
		vi.spyOn(app.itemService, 'update').mockResolvedValue()

		// Act
		const response = await app.inject({ method: 'PATCH', url, payload })

		// Assert
		expect(app.itemService.update).toHaveBeenCalledWith(itemId, payload)
		expect(response.statusCode).toBe(204)
		expect(response.body).toBe('')
	})
})

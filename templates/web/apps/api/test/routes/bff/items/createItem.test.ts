import createItem from '#/routes/bff/items/createItem.ts'

import type { FastifyInstance } from 'fastify'
import type { ItemMutation } from '@template/models'

describe('POST /bff/items route', () => {
	let app: FastifyInstance

	const url = '/bff/items'
	const payload: ItemMutation['CreateItem'] = { name: 'New item', description: 'A description' }

	beforeEach(async () => {
		app = await createTestApp()
		app.register(createItem)
	})

	it('Rejects an invalid payload with 400', async () => {
		// Arrange
		// Act
		const response = await app.inject({ method: 'POST', url, payload: { name: '' } })

		// Assert
		expect(response.statusCode).toBe(400)
		expect(app.itemService.create).not.toHaveBeenCalled()
	})

	it('Handles server error with 500 response and an error code', async () => {
		// Arrange
		vi.spyOn(app.itemService, 'create').mockRejectedValue(new Error('Fail'))

		// Act
		const response = await app.inject({ method: 'POST', url, payload })

		// Assert
		expect(response.statusCode).toBe(500)
		expect(response.json().error.code).toBe('failedToCreateItem')
	})

	it('Creates the item and returns its id', async () => {
		// Arrange
		vi.spyOn(app.itemService, 'create').mockResolvedValue('item-9')

		// Act
		const response = await app.inject({ method: 'POST', url, payload })

		// Assert
		expect(app.itemService.create).toHaveBeenCalledWith(payload)
		expect(response.statusCode).toBe(200)
		expect(response.json()).toEqual({ id: 'item-9' })
	})
})

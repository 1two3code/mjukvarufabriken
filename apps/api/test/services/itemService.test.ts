import { EntityNotFound } from '#/lib/entityError.ts'
import { createMockItem } from '#/services/__mocks__/itemService.ts'

import type { FastifyInstance } from 'fastify'
import type { Item } from '@mf/models'

describe('Item Service', () => {
	let app: FastifyInstance

	beforeEach(async () => {
		app = await createTestApp({ skipMock: '#/services/itemService.ts' })
	})

	describe('get', () => {
		it('Throws EntityNotFound when the item does not exist', async () => {
			// Arrange
			vi.spyOn(app.store, 'get').mockResolvedValue(undefined)

			// Act & Assert
			await expect(app.itemService.get('missing')).rejects.toBeInstanceOf(EntityNotFound)
		})

		it('Returns the stored item', async () => {
			// Arrange
			const item = createMockItem({ id: 'item-2' })
			vi.spyOn(app.store, 'get').mockResolvedValue(item)

			// Act
			const result = await app.itemService.get('item-2')

			// Assert
			expect(app.store.get).toHaveBeenCalledWith('items', 'item-2')
			expect(result).toEqual(item)
		})
	})

	describe('create', () => {
		it('Stores a new draft item and returns its id', async () => {
			// Arrange
			vi.spyOn(app.store, 'put').mockResolvedValue()

			// Act
			const id = await app.itemService.create({ name: 'New item', description: 'desc' })

			// Assert
			expect(id).toEqual(expect.any(String))
			expect(app.store.put).toHaveBeenCalledWith(
				'items',
				id,
				expect.objectContaining({
					id,
					name: 'New item',
					status: 'draft',
					createdAt: expect.any(String),
				})
			)
		})
	})

	describe('find', () => {
		const items: Item[] = [
			createMockItem({ id: '1', name: 'Alpha', status: 'active' }),
			createMockItem({ id: '2', name: 'Beta', status: 'draft' }),
			createMockItem({ id: '3', name: 'Alphabet', status: 'archived' }),
		]

		beforeEach(() => {
			vi.spyOn(app.store, 'list').mockResolvedValue(items)
		})

		it('Returns all items without a filter', async () => {
			// Act
			const result = await app.itemService.find()

			// Assert
			expect(app.store.list).toHaveBeenCalledWith('items')
			expect(result).toEqual(items)
		})

		it('Filters items by status', async () => {
			// Act
			const result = await app.itemService.find({ status: 'draft' })

			// Assert
			expect(result).toEqual([items[1]])
		})

		it('Filters items by case-insensitive name search', async () => {
			// Act
			const result = await app.itemService.find({ search: ' alpha ' })

			// Assert
			expect(result).toEqual([items[0], items[2]])
		})

		it('Combines status and search filters', async () => {
			// Act
			const result = await app.itemService.find({ status: 'archived', search: 'alpha' })

			// Assert
			expect(result).toEqual([items[2]])
		})
	})

	describe('update', () => {
		it('Merges updates into the existing item', async () => {
			// Arrange
			const item = createMockItem({ id: 'item-1' })
			vi.spyOn(app.itemService, 'get').mockResolvedValue(item)
			vi.spyOn(app.store, 'put').mockResolvedValue()

			// Act
			await app.itemService.update('item-1', { status: 'archived' })

			// Assert
			expect(app.itemService.get).toHaveBeenCalledWith('item-1')
			expect(app.store.put).toHaveBeenCalledWith('items', 'item-1', { ...item, status: 'archived' })
		})
	})
})

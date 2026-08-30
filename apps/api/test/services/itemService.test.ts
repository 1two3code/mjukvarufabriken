import { EntityNotFound } from '#/lib/entityError.ts'

import type { FastifyInstance } from 'fastify'
import type { ItemMutation } from '@mf/models'

describe('Item Service', () => {
	let app: FastifyInstance

	const create = (item: ItemMutation['CreateItem']) => app.itemService.create(item)

	beforeEach(async () => {
		app = await createTestApp({ skipMock: '#/services/itemService.ts' })
	})

	describe('get', () => {
		it('Throws EntityNotFound when the item does not exist', async () => {
			await expect(app.itemService.get('missing')).rejects.toBeInstanceOf(EntityNotFound)
		})

		it('Returns the stored item as a copy', async () => {
			// Arrange
			const id = await create({ name: 'Alpha', description: 'desc' })

			// Act
			const result = await app.itemService.get(id)
			result.name = 'mutated'

			// Assert
			expect(result).toEqual({
				id,
				name: 'mutated',
				description: 'desc',
				status: 'draft',
				createdAt: expect.any(String),
			})
			await expect(app.itemService.get(id)).resolves.toMatchObject({ name: 'Alpha' })
		})
	})

	describe('create', () => {
		it('Stores a new draft item and returns its id', async () => {
			// Act
			const id = await create({ name: 'New item', description: 'desc' })

			// Assert
			expect(id).toEqual(expect.any(String))
			await expect(app.itemService.get(id)).resolves.toMatchObject({
				id,
				name: 'New item',
				status: 'draft',
			})
		})
	})

	describe('find', () => {
		let ids: string[]

		beforeEach(async () => {
			ids = [
				await create({ name: 'Alpha', description: '' }),
				await create({ name: 'Beta', description: '' }),
				await create({ name: 'Alphabet', description: '' }),
			]
			await app.itemService.update(ids[0]!, { status: 'active' })
			await app.itemService.update(ids[2]!, { status: 'archived' })
		})

		it('Returns all items without a filter', async () => {
			// Act
			const result = await app.itemService.find()

			// Assert
			expect(result.map(item => item.id)).toEqual(ids)
		})

		it('Filters items by status', async () => {
			// Act
			const result = await app.itemService.find({ status: 'draft' })

			// Assert
			expect(result.map(item => item.name)).toEqual(['Beta'])
		})

		it('Filters items by case-insensitive name search', async () => {
			// Act
			const result = await app.itemService.find({ search: ' alpha ' })

			// Assert
			expect(result.map(item => item.name)).toEqual(['Alpha', 'Alphabet'])
		})

		it('Combines status and search filters', async () => {
			// Act
			const result = await app.itemService.find({ status: 'archived', search: 'alpha' })

			// Assert
			expect(result.map(item => item.name)).toEqual(['Alphabet'])
		})
	})

	describe('update', () => {
		it('Merges updates into the existing item', async () => {
			// Arrange
			const id = await create({ name: 'Alpha', description: 'desc' })

			// Act
			await app.itemService.update(id, { status: 'archived' })

			// Assert
			await expect(app.itemService.get(id)).resolves.toMatchObject({
				name: 'Alpha',
				status: 'archived',
			})
		})

		it('Throws EntityNotFound for an unknown item', async () => {
			await expect(
				app.itemService.update('missing', { status: 'archived' })
			).rejects.toBeInstanceOf(EntityNotFound)
		})
	})
})

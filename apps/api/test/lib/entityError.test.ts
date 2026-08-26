import { EntityError, EntityInvalid, EntityNotFound } from '#/lib/entityError.ts'

describe('EntityError', () => {
	it('Creates an EntityError with the correct message', () => {
		// Arrange
		// Act
		const error = new EntityError({ entityName: 'item', id: '123', type: 'invalid' })

		// Assert
		expect(error.message).toBe('item (123) is invalid')
	})

	it('Creates an EntityNotFound error with and without id', () => {
		// Arrange
		// Act
		const withId = new EntityNotFound('item', '123')
		const withoutId = new EntityNotFound('item')

		// Assert
		expect(withId.message).toBe('item (123) not found')
		expect(withId.type).toBe('notFound')
		expect(withId.entityName).toBe('item')
		expect(withoutId.message).toBe('item not found')
	})

	it('Creates an EntityInvalid error', () => {
		// Arrange
		// Act
		const error = new EntityInvalid('item', '123')

		// Assert
		expect(error.message).toBe('item (123) is invalid')
		expect(error.type).toBe('invalid')
		expect(error).toBeInstanceOf(EntityError)
	})
})

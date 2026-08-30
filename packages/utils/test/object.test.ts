import { isObject, mergeDeep, removeUndefinedProperties } from '../src/object.ts'

describe('Object utils', () => {
	describe('isObject', () => {
		it('Returns false when provided an array', () => {
			// Act
			const result = isObject([{ name: 'Item' }])

			// Assert
			expect(result).toBe(false)
		})

		it('Returns false when provided a primitive or null', () => {
			// Act & Assert
			expect(isObject('string')).toBe(false)
			expect(isObject(10)).toBe(false)
			expect(isObject(true)).toBe(false)
			expect(isObject(undefined)).toBe(false)
			expect(isObject(null)).toBe(false)
		})

		it('Returns true when provided an object', () => {
			// Act
			const result = isObject({ name: 'Item' })

			// Assert
			expect(result).toBe(true)
		})
	})

	describe('removeUndefinedProperties', () => {
		it('Removes all undefined properties from an object', () => {
			// Arrange
			const expectedResult = { name: 'Item' }
			const objectWithUndefined = { name: 'Item', description: undefined }

			// Act
			const result = removeUndefinedProperties(objectWithUndefined)

			// Assert
			expect(result).toEqual(expectedResult)
		})
	})

	describe('mergeDeep', () => {
		it('Merges nested object values without mutating the default', () => {
			// Arrange
			const item = {
				name: 'Item',
				meta: { tags: ['a'], details: { weight: 1 } },
			}

			// Act
			const result = mergeDeep(item, {
				name: 'Renamed item',
				meta: { details: { weight: 2 } },
			})

			// Assert
			expect(item.name).toBe('Item')
			expect(item.meta.details.weight).toBe(1)
			expect(result).toStrictEqual({
				name: 'Renamed item',
				meta: { tags: ['a'], details: { weight: 2 } },
			})
		})

		it('Returns a clone of the default when no overrides are given', () => {
			// Arrange
			const item = { name: 'Item', meta: { tags: ['a'] } }

			// Act
			const result = mergeDeep(item)

			// Assert
			expect(result).toStrictEqual(item)
			expect(result).not.toBe(item)
		})
	})
})

import { addTime, isValidDate, toUtc } from '../src/date.ts'

describe('Date utils', () => {
	describe('isValidDate', () => {
		it('Returns true for a valid date', () => {
			// Arrange
			const date = new Date('2025-01-01')

			// Act
			const result = isValidDate(date)

			// Assert
			expect(result).toBe(true)
		})

		it('Returns false for an invalid date', () => {
			// Arrange
			const date = new Date('invalid')

			// Act
			const result = isValidDate(date)

			// Assert
			expect(result).toBe(false)
		})
	})

	describe('toUtc', () => {
		it('Converts a date string to a UTC ISO string', () => {
			// Arrange
			const date = '2025-01-01T12:30:45'

			// Act
			const result = toUtc(date)

			// Assert
			expect(result).toBe(new Date(date).toISOString())
		})

		it('Throws when called with an invalid date string', () => {
			// Arrange
			const date = 'invalid'

			// Act & Assert
			expect(() => toUtc(date)).toThrow('Invalid date')
		})
	})

	describe('addTime', () => {
		it('Adds years to a date', () => {
			// Arrange
			const date = new Date('2025-01-01T12:30:45')

			// Act
			const result = addTime(date, 2, 'year')

			// Assert
			expect(result.getFullYear()).toBe(2027)
			expect(date.getFullYear()).toBe(2025)
		})

		it('Adds weeks to a date', () => {
			// Arrange
			const date = new Date('2025-01-01T12:30:45')

			// Act
			const result = addTime(date, 2, 'week')

			// Assert
			expect(result.getDate()).toBe(15)
		})

		it('Adds days across a month boundary', () => {
			// Arrange
			const date = new Date('2025-01-30T12:30:45')

			// Act
			const result = addTime(date, 3, 'day')

			// Assert
			expect(result.getMonth()).toBe(1)
			expect(result.getDate()).toBe(2)
		})

		it('Adds minutes across a day boundary', () => {
			// Arrange
			const date = new Date('2025-01-01T23:55:45')

			// Act
			const result = addTime(date, '10', 'minute')

			// Assert
			expect(result.getDate()).toBe(2)
			expect(result.getHours()).toBe(0)
			expect(result.getMinutes()).toBe(5)
		})
	})
})

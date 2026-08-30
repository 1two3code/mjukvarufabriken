import { isFunction, tryCatch, tryCatchSync } from '../src/function.ts'

describe('Function utils', () => {
	describe('isFunction', () => {
		it('Returns true if passed a function', () => {
			// Arrange
			const func = () => {}

			// Act
			const result = isFunction(func)

			// Assert
			expect(result).toBe(true)
		})

		it('Returns false if passed a non-function', () => {
			// Arrange
			const nonFunc = 123

			// Act
			const result = isFunction(nonFunc)

			// Assert
			expect(result).toBe(false)
		})
	})

	describe('tryCatch', () => {
		it('Returns result when promise resolves', async () => {
			// Arrange
			const promise = Promise.resolve('success')

			// Act
			const [error, result] = await tryCatch(promise)

			// Assert
			expect(error).toBeNull()
			expect(result).toBe('success')
		})

		it('Returns error when promise rejects', async () => {
			// Arrange
			const promise = Promise.reject(new Error('fail'))

			// Act
			const [error, result] = await tryCatch(promise)

			// Assert
			expect(error).toBeInstanceOf(Error)
			expect(error?.message).toBe('fail')
			expect(result).toBeNull()
		})
	})

	describe('tryCatchSync', () => {
		it('Returns result when function succeeds', () => {
			// Arrange
			const func = (a: number, b: number) => a + b

			// Act
			const [error, result] = tryCatchSync(func, 1, 2)

			// Assert
			expect(error).toBeNull()
			expect(result).toBe(3)
		})

		it('Returns error when function throws', () => {
			// Arrange
			const func = () => {
				throw new Error('fail')
			}

			// Act
			const [error, result] = tryCatchSync(func)

			// Assert
			expect(error).toBeInstanceOf(Error)
			expect(error?.message).toBe('fail')
			expect(result).toBeNull()
		})
	})
})

import { EntityInvalid } from '#/lib/entityError.ts'
import verifyMagicLink from '#/routes/bff/auth/verifyMagicLink.ts'
import { createMockTokenPair } from '#/services/__mocks__/authService.ts'

import type { FastifyInstance } from 'fastify'

const url = '/bff/auth/verify'

describe('POST /bff/auth/verify route', () => {
	let app: FastifyInstance

	beforeEach(async () => {
		app = await createTestApp()
		app.register(verifyMagicLink)
	})

	it('Returns the token pair for a valid link', async () => {
		// Arrange
		const pair = createMockTokenPair({ token: 'jwt' })
		vi.spyOn(app.authService, 'verifyMagicLink').mockResolvedValue(pair)

		// Act
		const response = await app.inject({ method: 'POST', url, payload: { token: 'abc' } })

		// Assert
		expect(response.statusCode).toBe(200)
		expect(response.json()).toEqual(pair)
		expect(app.authService.verifyMagicLink).toHaveBeenCalledWith('abc')
	})

	it('Answers 401 with a coded error for an invalid, used or expired link', async () => {
		// Arrange
		vi.spyOn(app.authService, 'verifyMagicLink').mockRejectedValueOnce(
			new EntityInvalid('magicLink')
		)

		// Act
		const response = await app.inject({ method: 'POST', url, payload: { token: 'abc' } })

		// Assert
		expect(response.statusCode).toBe(401)
		expect(response.json().error.code).toBe('invalidMagicLink')
	})

	it('Answers 500 on unexpected failures', async () => {
		// Arrange
		vi.spyOn(app.authService, 'verifyMagicLink').mockRejectedValueOnce(new Error('boom'))

		// Act
		const response = await app.inject({ method: 'POST', url, payload: { token: 'abc' } })

		// Assert
		expect(response.statusCode).toBe(500)
	})

	it('Rejects a missing token with 400', async () => {
		// Act
		const response = await app.inject({ method: 'POST', url, payload: {} })

		// Assert
		expect(response.statusCode).toBe(400)
	})
})

import { EntityInvalid } from '#/lib/entityError.ts'
import refresh from '#/routes/bff/auth/refresh.ts'
import { createMockTokenPair } from '#/services/__mocks__/authService.ts'

import type { FastifyInstance } from 'fastify'

const url = '/bff/auth/refresh'

describe('POST /bff/auth/refresh route', () => {
	let app: FastifyInstance

	beforeEach(async () => {
		app = await createTestApp()
		app.register(refresh)
	})

	it('Returns a rotated token pair (the shape the portal base query expects)', async () => {
		// Arrange
		const pair = createMockTokenPair({ refreshToken: 'rotated' })
		vi.spyOn(app.authService, 'refresh').mockResolvedValue(pair)

		// Act
		const response = await app.inject({ method: 'POST', url, payload: { refreshToken: 'old' } })

		// Assert
		expect(response.statusCode).toBe(200)
		expect(response.json()).toEqual({ token: pair.token, refreshToken: 'rotated' })
		expect(app.authService.refresh).toHaveBeenCalledWith('old')
	})

	it('Answers 401 when the refresh token is unknown or expired', async () => {
		// Arrange
		vi.spyOn(app.authService, 'refresh').mockRejectedValueOnce(new EntityInvalid('refreshToken'))

		// Act
		const response = await app.inject({ method: 'POST', url, payload: { refreshToken: 'old' } })

		// Assert
		expect(response.statusCode).toBe(401)
	})

	it('Rejects a missing refresh token with 400', async () => {
		// Act
		const response = await app.inject({ method: 'POST', url, payload: {} })

		// Assert
		expect(response.statusCode).toBe(400)
	})
})

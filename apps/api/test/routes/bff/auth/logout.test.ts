import logout from '#/routes/bff/auth/logout.ts'

import type { FastifyInstance } from 'fastify'

const url = '/bff/auth/logout'

describe('POST /bff/auth/logout route', () => {
	let app: FastifyInstance

	beforeEach(async () => {
		app = await createTestApp()
		app.register(logout)
	})

	it('Revokes the refresh token and answers 204', async () => {
		// Act
		const response = await app.inject({ method: 'POST', url, payload: { refreshToken: 'abc' } })

		// Assert
		expect(response.statusCode).toBe(204)
		expect(response.body).toBe('')
		expect(app.authService.logout).toHaveBeenCalledWith('abc')
	})

	it('Answers 500 when revocation fails', async () => {
		// Arrange
		vi.spyOn(app.authService, 'logout').mockRejectedValueOnce(new Error('store down'))

		// Act
		const response = await app.inject({ method: 'POST', url, payload: { refreshToken: 'abc' } })

		// Assert
		expect(response.statusCode).toBe(500)
	})
})

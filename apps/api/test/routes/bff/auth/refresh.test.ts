import refresh from '#/routes/bff/auth/refresh.ts'

import type { FastifyInstance } from 'fastify'

describe('POST /bff/auth/refresh route', () => {
	let app: FastifyInstance

	beforeEach(async () => {
		app = await createTestApp()
		app.register(refresh)
	})

	it('Answers 501 with a coded error until an identity provider is configured', async () => {
		// Arrange
		// Act
		const response = await app.inject({
			method: 'POST',
			url: '/bff/auth/refresh',
			payload: { refreshToken: 'abc' },
		})

		// Assert
		expect(response.statusCode).toBe(501)
		expect(response.json().error.code).toBe('refreshNotConfigured')
	})
})

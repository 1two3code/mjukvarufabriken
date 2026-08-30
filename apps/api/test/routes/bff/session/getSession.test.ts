import { getMockToken } from '#/plugins/__mocks__/auth.ts'
import getSession from '#/routes/bff/session/getSession.ts'

import type { FastifyInstance } from 'fastify'

describe('GET /bff/session route', () => {
	let app: FastifyInstance

	beforeEach(async () => {
		app = await createTestApp()
		app.register(getSession)
	})

	it('Returns the session derived from the token', async () => {
		// Arrange
		const token = getMockToken()

		// Act
		const response = await app.inject({ url: '/bff/session' })

		// Assert
		expect(response.statusCode).toBe(200)
		expect(response.json()).toEqual({ userId: token.sub, role: token.role, name: token.name })
	})
})

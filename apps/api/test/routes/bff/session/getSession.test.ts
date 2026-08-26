import { getMockToken } from '#/plugins/__mocks__/auth.ts'
import getSession from '#/routes/bff/session/getSession.ts'
import { createMockOrg, createMockUser } from '#/services/__mocks__/userService.ts'

import type { FastifyInstance } from 'fastify'

describe('GET /bff/session route', () => {
	let app: FastifyInstance

	beforeEach(async () => {
		app = await createTestApp()
		app.register(getSession)
	})

	it('Returns the user and org for the session', async () => {
		// Arrange
		const token = getMockToken()
		const user = createMockUser({ id: token.sub })
		const org = createMockOrg({ id: user.orgId })

		// Act
		const response = await app.inject({ url: '/bff/session' })

		// Assert
		expect(response.statusCode).toBe(200)
		expect(app.userService.get).toHaveBeenCalledWith(token.sub)
		expect(app.userService.getOrg).toHaveBeenCalledWith(user.orgId)
		expect(response.json()).toEqual({
			userId: user.id,
			role: user.role,
			name: user.name,
			user,
			org,
		})
	})

	it('Falls back to the email as display name', async () => {
		// Arrange
		const user = createMockUser({ id: 'user-1', name: undefined })
		delete user.name
		vi.spyOn(app.userService, 'get').mockResolvedValue(user)

		// Act
		const response = await app.inject({ url: '/bff/session' })

		// Assert
		expect(response.json().name).toBe(user.email)
	})

	it('Answers 500 when the user cannot be loaded', async () => {
		// Arrange
		vi.spyOn(app.userService, 'get').mockRejectedValueOnce(new Error('gone'))

		// Act
		const response = await app.inject({ url: '/bff/session' })

		// Assert
		expect(response.statusCode).toBe(500)
	})
})

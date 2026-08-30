import type { FastifyInstance } from 'fastify'

describe('Access control plugin', () => {
	let app: FastifyInstance

	beforeEach(async () => {
		// The auth mock decorates every request with a session of role `user`
		app = await createTestApp({ skipMock: '#/plugins/accessControl.ts' })
	})

	it('Bypasses routes without a permissions configuration', async () => {
		// Arrange
		app.get('/bypass', (_, reply) => reply.send())

		// Act
		const response = await app.inject({ url: '/bypass' })

		// Assert
		expect(response.statusCode).toBe(200)
	})

	it('Returns 403 if the session role lacks a required permission', async () => {
		// Arrange
		app.get('/admin', { config: { permissions: ['user:all'] } }, (_, reply) => reply.send())

		// Act
		const response = await app.inject({ url: '/admin' })

		// Assert
		expect(response.statusCode).toBe(403)
		expect(response.json()).toEqual({
			error: expect.objectContaining({
				message: 'You do not have permission to access this resource',
			}),
		})
	})

	it('Allows access if the session role has all required permissions', async () => {
		// Arrange
		app.get('/specs', { config: { permissions: ['spec:read', 'spec:write'] } }, (_, reply) =>
			reply.send()
		)

		// Act
		const response = await app.inject({ url: '/specs' })

		// Assert
		expect(response.statusCode).toBe(200)
	})
})

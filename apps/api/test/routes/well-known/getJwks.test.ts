import getJwks from '#/routes/well-known/getJwks.ts'

import type { FastifyInstance } from 'fastify'

describe('GET /.well-known/jwks.json route', () => {
	let app: FastifyInstance

	beforeEach(async () => {
		app = await createTestApp()
		app.register(getJwks)
	})

	it('Publishes the public signing key with its thumbprint as kid', async () => {
		// Act
		const response = await app.inject({ url: '/.well-known/jwks.json' })

		// Assert
		expect(response.statusCode).toBe(200)
		expect(response.headers['cache-control']).toBe('public, max-age=3600')
		expect(response.json()).toEqual({
			keys: [
				expect.objectContaining({
					kty: 'OKP',
					crv: 'Ed25519',
					alg: 'EdDSA',
					use: 'sig',
					kid: app.authKeys.kid,
					x: expect.any(String),
				}),
			],
		})
		expect(response.json().keys[0]).not.toHaveProperty('d')
	})
})

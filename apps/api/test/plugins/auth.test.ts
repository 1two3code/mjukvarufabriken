import { exportJWK, generateKeyPair, SignJWT } from 'jose'

import type { FastifyInstance } from 'fastify'
import type { CryptoKey, JWK } from 'jose'

const createToken = async (
	privateKey: CryptoKey,
	app: FastifyInstance,
	claims: Record<string, unknown>,
	overrides: { issuer?: string; audience?: string } = {}
) =>
	new SignJWT(claims)
		.setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
		.setIssuedAt()
		.setIssuer(overrides.issuer ?? app.secrets.authIssuer)
		.setAudience(overrides.audience ?? app.secrets.authAudience)
		.setExpirationTime('1h')
		.sign(privateKey)

describe('Auth plugin (auth)', () => {
	let app: FastifyInstance
	let privateKey: CryptoKey
	let jwk: JWK

	beforeAll(async () => {
		const keyPair = await generateKeyPair('RS256')
		privateKey = keyPair.privateKey
		jwk = { ...(await exportJWK(keyPair.publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' }
	})

	beforeEach(async () => {
		app = await createTestApp({ skipMock: '#/plugins/auth.ts' })
		networkMock.get(app.secrets.authJwksUrl).reply(200, { keys: [jwk] })
	})

	describe('Public routes', () => {
		it('Allows /bff/auth/refresh to bypass the auth plugin', async () => {
			// Arrange
			app.get('/bff/auth/refresh', () => ({ message: 'Resolved' }))

			// Act
			const response = await app.inject({ url: '/bff/auth/refresh' })

			// Assert
			expect(response.statusCode).toBe(200)
		})

		it('Allows routes outside /bff to bypass the auth plugin', async () => {
			// Arrange
			app.get('/health', () => ({ message: 'OK' }))

			// Act
			const response = await app.inject({ url: '/health' })

			// Assert
			expect(response.statusCode).toBe(200)
		})
	})

	describe('Protected routes', () => {
		it('Returns 401 if no token is provided', async () => {
			// Arrange
			app.get('/bff/', () => ({}))

			// Act
			const response = await app.inject({ url: '/bff/' })

			// Assert
			expect(response.statusCode).toBe(401)
			expect(response.json()).toEqual({ message: 'Unauthorized' })
		})

		it('Decorates the request with token and session when a valid token is provided', async () => {
			// Arrange
			const token = await createToken(privateKey, app, {
				sub: 'user-1',
				role: 'admin',
				name: 'Leela',
			})
			let captured: { session: unknown; encoded: string } | null = null
			app.get('/bff/', request => {
				captured = { session: request.session, encoded: request.token.encoded }
				return ''
			})

			// Act
			const response = await app.inject({
				url: '/bff/',
				headers: { authorization: `Bearer ${token}` },
			})

			// Assert
			expect(response.statusCode).toBe(200)
			expect(captured).toEqual({ session: { userId: 'user-1', role: 'admin' }, encoded: token })
			expect(networkMock.get(app.secrets.authJwksUrl).reply(200).spy.called(1)).toBe(true)
		})

		it('Returns 401 when the token has an unknown role', async () => {
			// Arrange
			const token = await createToken(privateKey, app, { sub: 'user-1', role: 'superuser' })
			app.get('/bff/', () => '')

			// Act
			const response = await app.inject({
				url: '/bff/',
				headers: { authorization: `Bearer ${token}` },
			})

			// Assert
			expect(response.statusCode).toBe(401)
		})

		it('Returns 401 when the issuer does not match', async () => {
			// Arrange
			const token = await createToken(
				privateKey,
				app,
				{ sub: 'user-1', role: 'user' },
				{ issuer: 'https://someone-else.example.com' }
			)
			app.get('/bff/', () => '')

			// Act
			const response = await app.inject({
				url: '/bff/',
				headers: { authorization: `Bearer ${token}` },
			})

			// Assert
			expect(response.statusCode).toBe(401)
		})

		it('Returns 401 when the token is signed by an unknown key', async () => {
			// Arrange
			const { privateKey: otherKey } = await generateKeyPair('RS256')
			const token = await createToken(otherKey, app, { sub: 'user-1', role: 'user' })
			app.get('/bff/', () => '')

			// Act
			const response = await app.inject({
				url: '/bff/',
				headers: { authorization: `Bearer ${token}` },
			})

			// Assert
			expect(response.statusCode).toBe(401)
		})
	})
})

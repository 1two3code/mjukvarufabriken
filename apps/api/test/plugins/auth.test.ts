import { generateKeyPair, SignJWT } from 'jose'

import { authAlgorithm } from '#/plugins/authKeys.utils.ts'

import type { FastifyInstance } from 'fastify'
import type { CryptoKey } from 'jose'

const createToken = async (
	privateKey: CryptoKey,
	app: FastifyInstance,
	claims: Record<string, unknown>,
	overrides: { issuer?: string; audience?: string } = {}
) =>
	new SignJWT(claims)
		.setProtectedHeader({ alg: authAlgorithm, kid: app.authKeys.kid })
		.setIssuedAt()
		.setIssuer(overrides.issuer ?? app.secrets.authIssuer)
		.setAudience(overrides.audience ?? app.secrets.authAudience)
		.setExpirationTime('1h')
		.sign(privateKey)

const validClaims = { sub: 'user-1', role: 'admin', orgId: 'org-1', email: 'leela@example.com' }

describe('Auth plugin (auth)', () => {
	let app: FastifyInstance

	beforeEach(async () => {
		app = await createTestApp({ skipMock: '#/plugins/auth.ts' })
	})

	describe('Public routes', () => {
		it.each([
			'/bff/auth/magic-link',
			'/bff/auth/verify',
			'/bff/auth/refresh',
			'/bff/auth/logout',
			// The site's no-login quote chat (wave 14, F1)
			'/bff/quote',
			'/bff/quote/:orderId',
			'/bff/quote/:orderId/message',
		])('Allows %s to bypass the auth plugin', async url => {
			// Arrange
			app.get(url, () => ({ message: 'Resolved' }))

			// Act
			const response = await app.inject({ url })

			// Assert
			expect(response.statusCode).toBe(200)
		})

		it('Allows routes outside /bff to bypass the auth plugin', async () => {
			// Arrange
			app.get('/.well-known/jwks.json', () => ({ keys: [] }))
			app.get('/health', () => ({ message: 'OK' }))

			// Act
			const jwks = await app.inject({ url: '/.well-known/jwks.json' })
			const health = await app.inject({ url: '/health' })

			// Assert
			expect(jwks.statusCode).toBe(200)
			expect(health.statusCode).toBe(200)
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

		it('Accepts a token minted with the local authKeys and decorates token + session', async () => {
			// Arrange
			const token = await createToken(app.authKeys.privateKey, app, {
				...validClaims,
				name: 'Leela',
			})
			let captured: { session: unknown; encoded: string; email: string } | null = null
			app.get('/bff/', request => {
				captured = {
					session: request.session,
					encoded: request.token.encoded,
					email: request.token.email,
				}
				return ''
			})

			// Act
			const response = await app.inject({
				url: '/bff/',
				headers: { authorization: `Bearer ${token}` },
			})

			// Assert
			expect(response.statusCode).toBe(200)
			expect(captured).toEqual({
				session: { userId: 'user-1', role: 'admin', orgId: 'org-1' },
				encoded: token,
				email: 'leela@example.com',
			})
		})

		it('Returns 401 when the token has an unknown role', async () => {
			// Arrange
			const token = await createToken(app.authKeys.privateKey, app, {
				...validClaims,
				role: 'superuser',
			})
			app.get('/bff/', () => '')

			// Act
			const response = await app.inject({
				url: '/bff/',
				headers: { authorization: `Bearer ${token}` },
			})

			// Assert
			expect(response.statusCode).toBe(401)
		})

		it('Returns 401 when the token lacks the orgId claim', async () => {
			// Arrange
			const token = await createToken(app.authKeys.privateKey, app, { sub: 'u', role: 'user' })
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
			const token = await createToken(app.authKeys.privateKey, app, validClaims, {
				issuer: 'https://someone-else.example.com',
			})
			app.get('/bff/', () => '')

			// Act
			const response = await app.inject({
				url: '/bff/',
				headers: { authorization: `Bearer ${token}` },
			})

			// Assert
			expect(response.statusCode).toBe(401)
		})

		it('Returns 401 when the audience does not match', async () => {
			// Arrange
			const token = await createToken(app.authKeys.privateKey, app, validClaims, {
				audience: 'someone-else',
			})
			app.get('/bff/', () => '')

			// Act
			const response = await app.inject({
				url: '/bff/',
				headers: { authorization: `Bearer ${token}` },
			})

			// Assert
			expect(response.statusCode).toBe(401)
		})

		it('Returns 401 when the token is signed by another key (bad signature)', async () => {
			// Arrange
			const { privateKey: otherKey } = await generateKeyPair(authAlgorithm, { crv: 'Ed25519' })
			const token = await createToken(otherKey, app, validClaims)
			app.get('/bff/', () => '')

			// Act
			const response = await app.inject({
				url: '/bff/',
				headers: { authorization: `Bearer ${token}` },
			})

			// Assert
			expect(response.statusCode).toBe(401)
		})

		it('Returns 401 when the token is expired', async () => {
			// Arrange
			const token = await new SignJWT(validClaims)
				.setProtectedHeader({ alg: authAlgorithm })
				.setIssuer(app.secrets.authIssuer)
				.setAudience(app.secrets.authAudience)
				.setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
				.setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
				.sign(app.authKeys.privateKey)
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

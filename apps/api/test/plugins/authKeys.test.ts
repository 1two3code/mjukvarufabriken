import { generateKeyPair } from 'node:crypto'
import { promisify } from 'node:util'

import { jwtVerify, SignJWT } from 'jose'

import { authAlgorithm } from '#/plugins/authKeys.utils.ts'

import type { JWK } from 'jose'

const generateKeyPairAsync = promisify(generateKeyPair)

const generatePrivateJwk = async () => {
	const { privateKey } = await generateKeyPairAsync('ed25519')
	return privateKey.export({ format: 'jwk' }) as JWK
}

/** Boots the real secrets + authKeys plugins with the given key configuration */
const createApp = async (privateJwk?: string) => {
	vi.stubEnv('AUTH_AUDIENCE', 'audience')
	vi.stubEnv('AUTH_JWT_PRIVATE_KEY', privateJwk ?? '')
	vi.stubEnv('AUTH_JWT_PRIVATE_KEY_SECRET_ARN', '')
	vi.stubEnv('ANTHROPIC_API_KEY', '')
	vi.stubEnv('ANTHROPIC_API_KEY_SECRET_ARN', '')
	vi.doUnmock('#/plugins/secrets.ts')
	vi.resetModules()
	return createTestApp({ skipMock: ['#/plugins/authKeys.ts', '#/plugins/secrets.ts'] })
}

describe('Auth keys plugin (authKeys)', () => {
	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it('Loads the configured Ed25519 private JWK and derives the public JWK', async () => {
		// Arrange
		const privateJwk = await generatePrivateJwk()

		// Act
		const app = await createApp(JSON.stringify(privateJwk))

		// Assert
		expect(app.authKeys.ephemeral).toBe(false)
		expect(app.authKeys.jwks.keys).toHaveLength(1)
		const [publicJwk] = app.authKeys.jwks.keys
		expect(publicJwk).toEqual({
			kty: 'OKP',
			crv: 'Ed25519',
			x: privateJwk.x,
			kid: app.authKeys.kid,
			alg: authAlgorithm,
			use: 'sig',
		})
		expect(publicJwk).not.toHaveProperty('d')
	})

	it('Signs with the private key and verifies with the public key', async () => {
		// Arrange
		const app = await createApp(JSON.stringify(await generatePrivateJwk()))
		const token = await new SignJWT({ role: 'user' })
			.setProtectedHeader({ alg: authAlgorithm, kid: app.authKeys.kid })
			.setSubject('user-1')
			.sign(app.authKeys.privateKey)

		// Act
		const { payload, protectedHeader } = await jwtVerify(token, app.authKeys.publicKey)

		// Assert
		expect(payload.sub).toBe('user-1')
		expect(protectedHeader.kid).toBe(app.authKeys.kid)
	})

	it('Generates an ephemeral key pair when no key is configured', async () => {
		// Arrange & Act
		const first = await createApp()
		const second = await createApp()

		// Assert
		expect(first.authKeys.ephemeral).toBe(true)
		expect(first.authKeys.jwks.keys[0]?.crv).toBe('Ed25519')
		expect(first.authKeys.kid).not.toBe(second.authKeys.kid)
	})

	it('Refuses to boot with a key that is not an Ed25519 private JWK', async () => {
		// Arrange
		const rsaLike = JSON.stringify({ kty: 'RSA', n: 'abc', e: 'AQAB', d: 'def' })

		// Act & Assert
		await expect(createApp(rsaLike)).rejects.toThrow('not an Ed25519 (OKP) private JWK')
		await expect(createApp('not-json')).rejects.toThrow('not valid JSON')
	})
})

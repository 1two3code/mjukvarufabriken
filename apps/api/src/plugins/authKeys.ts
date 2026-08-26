import fp from 'fastify-plugin'
import { calculateJwkThumbprint, exportJWK, generateKeyPair, importJWK } from 'jose'

import { authAlgorithm } from '#/plugins/authKeys.utils.ts'

import type { FastifyPluginAsync } from 'fastify'
import type { CryptoKey, JWK } from 'jose'

declare module 'fastify' {
	interface FastifyInstance {
		/**
		 * The api's own Ed25519 signing key pair. `privateKey` signs access tokens, `publicKey`
		 * verifies them locally, and `jwks` is what `/.well-known/jwks.json` publishes.
		 */
		authKeys: {
			privateKey: CryptoKey
			publicKey: CryptoKey
			/** RFC 7638 thumbprint of the public key; the `kid` header on every token */
			kid: string
			jwks: { keys: JWK[] }
			/** True when no key was configured and a throwaway pair was generated at boot */
			ephemeral: boolean
		}
	}
}

const isEd25519PrivateJwk = (value: unknown): value is JWK =>
	typeof value === 'object' &&
	value !== null &&
	(value as JWK).kty === 'OKP' &&
	(value as JWK).crv === 'Ed25519' &&
	typeof (value as JWK).d === 'string' &&
	typeof (value as JWK).x === 'string'

const parsePrivateJwk = (raw: string): JWK => {
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		throw new Error('AUTH_JWT_PRIVATE_KEY is not valid JSON')
	}
	if (!isEd25519PrivateJwk(parsed)) {
		throw new Error('AUTH_JWT_PRIVATE_KEY is not an Ed25519 (OKP) private JWK')
	}
	return parsed
}

/** Imports a configured private JWK and derives the public key from it */
const importConfiguredKeys = async (raw: string) => {
	const privateJwk = parsePrivateJwk(raw)
	const publicJwk: JWK = { kty: privateJwk.kty, crv: privateJwk.crv, x: privateJwk.x }
	const privateKey = (await importJWK(privateJwk, authAlgorithm)) as CryptoKey
	const publicKey = (await importJWK(publicJwk, authAlgorithm)) as CryptoKey
	return { privateKey, publicKey, publicJwk }
}

const generateEphemeralKeys = async () => {
	const { privateKey, publicKey } = await generateKeyPair(authAlgorithm, { crv: 'Ed25519' })
	return { privateKey, publicKey, publicJwk: await exportJWK(publicKey) }
}

const plugin: FastifyPluginAsync = async app => {
	const { authJwtPrivateKey, env } = app.secrets
	const ephemeral = !authJwtPrivateKey

	if (ephemeral && env !== 'test') {
		app.log.warn(
			'AUTH_JWT_PRIVATE_KEY is not configured — using an EPHEMERAL signing key. ' +
				'Every issued token becomes invalid when the api restarts. ' +
				'Generate one with `node scripts/gen-auth-key.mjs` and set AUTH_JWT_PRIVATE_KEY or AUTH_JWT_PRIVATE_KEY_SECRET_ARN.'
		)
	}

	const { privateKey, publicKey, publicJwk } = ephemeral
		? await generateEphemeralKeys()
		: await importConfiguredKeys(authJwtPrivateKey)

	const kid = await calculateJwkThumbprint(publicJwk)

	app.decorate('authKeys', {
		privateKey,
		publicKey,
		kid,
		jwks: { keys: [{ ...publicJwk, kid, alg: authAlgorithm, use: 'sig' }] },
		ephemeral,
	})
}

export default fp(plugin, { name: '#internal/authKeys', dependencies: ['#internal/secrets'] })

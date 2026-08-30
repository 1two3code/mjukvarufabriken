import fp from 'fastify-plugin'
import { calculateJwkThumbprint, exportJWK, generateKeyPair } from 'jose'

import { authAlgorithm } from '#/plugins/authKeys.utils.ts'

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'

// One real Ed25519 pair per test file — tokens minted with it verify like in production.
const keyPair = await generateKeyPair(authAlgorithm, { crv: 'Ed25519' })
const publicJwk = await exportJWK(keyPair.publicKey)
const kid = await calculateJwkThumbprint(publicJwk)

export const getMockAuthKeys = (): FastifyInstance['authKeys'] => ({
	privateKey: keyPair.privateKey,
	publicKey: keyPair.publicKey,
	kid,
	jwks: { keys: [{ ...publicJwk, kid, alg: authAlgorithm, use: 'sig' }] },
	ephemeral: true,
})

const mockPlugin: FastifyPluginAsync = async app => {
	app.decorate('authKeys', getMockAuthKeys())
}

export default fp(mockPlugin, { name: '#internal/authKeys' })

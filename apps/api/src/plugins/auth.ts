import fp from 'fastify-plugin'
import { jwtVerify } from 'jose'
import { role as roles } from '@mf/access-control'

import { authAlgorithm } from '#/plugins/authKeys.utils.ts'

import type { FastifyPluginAsync } from 'fastify'
import type { Simplify } from 'type-fest'
import type { Role } from '@mf/access-control'
import type { BackendSession } from '@mf/models'

/** Claims of an access token minted by `authService` */
export type DecodedToken = {
	sub: string
	email: string
	name?: string
	role: Role
	orgId: string
	iss: string
	aud: string | string[]
	exp: number
	iat: number
}

export type RequestToken = Simplify<DecodedToken & { encoded: string }>

declare module 'fastify' {
	interface FastifyRequest {
		token: RequestToken
		session: BackendSession
	}
}

/**
 * Routes under /bff that are reachable without a token.
 * Everything outside /bff (e.g. /health, /.well-known/jwks.json) is always public.
 */
export const publicUrls = new Set([
	'/bff/auth/magic-link',
	'/bff/auth/verify',
	'/bff/auth/refresh',
	'/bff/auth/logout',
	'/bff/auth/github',
	'/bff/auth/github/callback',
	'/bff/contact',
	// The public demo gallery (wave 14, F3): read-only, per-ip rate-limited in its service
	'/bff/showcases',
	// The site's no-login spec chat (wave 14, F1): each route checks the quote token itself and
	// is ip-rate-limited; the token is the visitor's only credential
	'/bff/quote',
	'/bff/quote/:orderId',
	'/bff/quote/:orderId/message',
	// Stripe calls the webhook with its own signature (the fake provider's checkout is a normal
	// authenticated POST, so it is not listed here)
	'/bff/stripe/webhook',
	'/.well-known/jwks.json',
	'/health',
])

const isRole = (value: unknown): value is Role =>
	typeof value === 'string' && Object.values<string>(roles).includes(value)

/**
 * Verifies bearer tokens against the api's own public key (`authKeys`) — the api is its own
 * token issuer, so no remote JWKS is fetched.
 */
const plugin: FastifyPluginAsync = async app => {
	const { secrets, authKeys } = app

	app.decorateRequest('token')
	app.decorateRequest('session')

	// Validate token on incoming requests
	app.addHook('onRequest', async (request, reply) => {
		const incomingUrl = request.routeOptions.url ?? ''
		if (publicUrls.has(incomingUrl) || !incomingUrl.startsWith('/bff')) return

		try {
			const token = request.headers.authorization?.replace('Bearer ', '')
			if (!token) throw new Error('No token provided')

			const { payload } = await jwtVerify<DecodedToken>(token, authKeys.publicKey, {
				issuer: secrets.authIssuer,
				audience: secrets.authAudience,
				algorithms: [authAlgorithm],
			})
			if (!payload.sub) throw new Error('Token is missing the sub claim')
			if (!isRole(payload.role)) throw new Error('Token is missing a valid role claim')
			if (typeof payload.orgId !== 'string') throw new Error('Token is missing the orgId claim')

			request.token = { ...payload, encoded: token }
			request.session = { userId: payload.sub, role: payload.role, orgId: payload.orgId }
		} catch {
			reply.code(401).send({ message: 'Unauthorized' })
		}
	})
}

export default fp(plugin, {
	name: '#internal/auth',
	dependencies: ['#internal/secrets', '#internal/authKeys'],
})

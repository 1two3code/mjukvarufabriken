import fp from 'fastify-plugin'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { role as roles } from '@template/access-control'

import type { FastifyPluginAsync } from 'fastify'
import type { Simplify } from 'type-fest'
import type { Role } from '@template/access-control'
import type { BackendSession } from '@template/models'

type DecodedToken = {
	sub: string
	name?: string
	role: Role
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
 * Everything outside /bff (e.g. /health) is always public.
 */
const publicUrls = new Set(['/bff/auth/refresh'])

const isRole = (value: unknown): value is Role =>
	typeof value === 'string' && Object.values<string>(roles).includes(value)

const plugin: FastifyPluginAsync = async app => {
	const { secrets } = app

	const jwks = createRemoteJWKSet(new URL(secrets.authJwksUrl), {
		cooldownDuration: 24 * 60 * 60 * 1000, // 24 hours
	})

	app.decorateRequest('token')
	app.decorateRequest('session')

	// Validate token on incoming requests
	app.addHook('onRequest', async (request, reply) => {
		const incomingUrl = request.routeOptions.url ?? ''
		if (publicUrls.has(incomingUrl) || !incomingUrl.startsWith('/bff')) return

		try {
			const token = request.headers.authorization?.replace('Bearer ', '')
			if (!token) throw new Error('No token provided')

			const { payload } = await jwtVerify<DecodedToken>(token, jwks, {
				issuer: secrets.authIssuer,
				audience: secrets.authAudience,
			})
			if (!payload.sub) throw new Error('Token is missing the sub claim')
			if (!isRole(payload.role)) throw new Error('Token is missing a valid role claim')

			request.token = { ...payload, encoded: token }
			request.session = { userId: payload.sub, role: payload.role }
		} catch {
			reply.code(401).send({ message: 'Unauthorized' })
		}
	})
}

export default fp(plugin, { name: '#internal/auth', dependencies: ['#internal/secrets'] })

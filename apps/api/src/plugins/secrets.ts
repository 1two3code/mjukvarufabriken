import fp from 'fastify-plugin'

import type { FastifyPluginAsync } from 'fastify'

declare module 'fastify' {
	interface FastifyInstance {
		secrets: {
			/** Public URL of the SPA, used for CORS */
			appUrl: string
			/** JWKS endpoint of the identity provider */
			authJwksUrl: string
			/** Expected `iss` claim */
			authIssuer: string
			/** Expected `aud` claim */
			authAudience: string
		}
	}
}

const required = ['AUTH_JWKS_URL', 'AUTH_ISSUER', 'AUTH_AUDIENCE'] as const

/**
 * Reads configuration from the environment. Swap the body of this plugin for a
 * secrets manager / parameter store lookup when deploying — consumers only depend
 * on `app.secrets`.
 */
const plugin: FastifyPluginAsync = async app => {
	const missing = required.filter(name => !process.env[name])
	if (missing.length) {
		throw new Error(`Missing required environment variables: ${missing.join(', ')}`)
	}

	app.decorate('secrets', {
		appUrl: process.env.APP_URL ?? 'http://localhost:5173',
		authJwksUrl: process.env.AUTH_JWKS_URL!,
		authIssuer: process.env.AUTH_ISSUER!,
		authAudience: process.env.AUTH_AUDIENCE!,
	})
}

export default fp(plugin, { name: '#internal/secrets' })

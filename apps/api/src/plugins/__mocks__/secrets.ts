import fp from 'fastify-plugin'

import type { FastifyPluginAsync } from 'fastify'

const mockPlugin: FastifyPluginAsync = async app => {
	app.decorate('secrets', {
		appUrl: 'http://localhost:5173',
		authJwksUrl: 'https://auth.example.com/.well-known/jwks.json',
		authIssuer: 'https://auth.example.com',
		authAudience: 'mjukvaruhuset',
	})
}

export default fp(mockPlugin, { name: '#internal/secrets' })

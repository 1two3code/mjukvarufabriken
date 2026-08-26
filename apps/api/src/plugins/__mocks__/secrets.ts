import fp from 'fastify-plugin'

import type { FastifyPluginAsync } from 'fastify'

const mockPlugin: FastifyPluginAsync = async app => {
	app.decorate('secrets', {
		env: 'test',
		appUrl: 'http://localhost:5173',
		portalUrl: 'https://portal.example.com',
		authIssuer: 'https://api.example.com',
		authAudience: 'mjukvaruhuset',
		authJwtPrivateKey: undefined,
		authAdminEmails: ['admin@example.com'],
		emailTransport: 'log',
		emailFrom: 'noreply@example.com',
		anthropicApiKey: 'sk-ant-test',
		infra: { jobSubnetIds: [] },
	})
}

export default fp(mockPlugin, { name: '#internal/secrets' })

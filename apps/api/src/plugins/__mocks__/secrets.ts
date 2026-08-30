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
		sentryDsn: 'https://public@o0.ingest.sentry.io/1',
		residentInstallations: { 'acme-shop': 'installation-token' },
		githubOauth: { clientId: 'gh-client-id', clientSecret: 'gh-client-secret' },
		residentBilling: { meterEvent: 'resident_usage_usd_cents', priceId: 'price_resident' },
		provisionAccounts: false,
		orgLifecycle: { enabled: false, region: 'eu-north-1', graceDays: 30 },
		infra: { jobSubnetIds: [], jobApiUrl: 'https://api.example.com' },
	})
}

export default fp(mockPlugin, { name: '#internal/secrets' })

import fp from 'fastify-plugin'

import type { FastifyPluginAsync } from 'fastify'

const plugin: FastifyPluginAsync = async app => {
	app.decorate('sentry', { captureException: vi.fn() })
}

export default fp(plugin, { name: '#internal/sentry' })

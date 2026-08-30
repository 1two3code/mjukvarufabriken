import fp from 'fastify-plugin'

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'

const mockPlugin: FastifyPluginAsync = async app => {
	const mock: FastifyInstance['metrics'] = {
		recordJobFailed: vi.fn().mockResolvedValue(undefined),
		recordJobTokensUsed: vi.fn().mockResolvedValue(undefined),
	}

	app.decorate('metrics', mock)
}

export default fp(mockPlugin, { name: '#internal/metrics' })

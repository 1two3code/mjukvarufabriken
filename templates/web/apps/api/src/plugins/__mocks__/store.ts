import fp from 'fastify-plugin'

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'

const mockPlugin: FastifyPluginAsync = async app => {
	const mock: FastifyInstance['store'] = {
		kind: 'memory',
		get: vi.fn().mockResolvedValue(undefined),
		list: vi.fn().mockResolvedValue([]),
		put: vi.fn(),
		delete: vi.fn().mockResolvedValue(true),
		close: vi.fn(),
	}

	app.decorate('store', mock)
}

export default fp(mockPlugin, { name: '#internal/store' })

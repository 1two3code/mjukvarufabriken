import fp from 'fastify-plugin'

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'

const mockPlugin: FastifyPluginAsync = async app => {
	const mock: FastifyInstance['objectStorage'] = {
		kind: 'memory',
		put: vi.fn(),
		get: vi.fn().mockResolvedValue(undefined),
		url: vi.fn().mockResolvedValue('https://example.test/object'),
		delete: vi.fn().mockResolvedValue(true),
		close: vi.fn(),
	}

	app.decorate('objectStorage', mock)
}

export default fp(mockPlugin, { name: '#internal/objectStorage' })

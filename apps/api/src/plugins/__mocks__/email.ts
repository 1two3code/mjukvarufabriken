import fp from 'fastify-plugin'

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'

const mockPlugin: FastifyPluginAsync = async app => {
	const mock: FastifyInstance['email'] = {
		send: vi.fn().mockResolvedValue(undefined),
	}

	app.decorate('email', mock)
}

export default fp(mockPlugin, { name: '#internal/email' })

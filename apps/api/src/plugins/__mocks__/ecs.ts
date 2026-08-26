import fp from 'fastify-plugin'

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'

export const mockTaskArn = 'arn:aws:ecs:eu-north-1:123456789012:task/mf-jobs-test/abc123'

const mockPlugin: FastifyPluginAsync = async app => {
	const mock: FastifyInstance['ecs'] = {
		configured: true,
		runJob: vi.fn().mockResolvedValue(mockTaskArn),
		stopTask: vi.fn().mockResolvedValue(undefined),
	}

	app.decorate('ecs', mock)
}

export default fp(mockPlugin, { name: '#internal/ecs' })

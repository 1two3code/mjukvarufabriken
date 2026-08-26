import fp from 'fastify-plugin'

import { createMockJob, createMockJobEvent } from '#/plugins/__mocks__/db.ts'

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'

const mockPlugin: FastifyPluginAsync = async app => {
	const mock: FastifyInstance['jobService'] = {
		start: vi.fn((orderId: string) => Promise.resolve(createMockJob({ orderId }))),
		get: vi.fn((id: string) => Promise.resolve(createMockJob({ id }))),
		listForOrder: vi.fn((orderId: string) => Promise.resolve([createMockJob({ orderId })])),
		listEvents: vi.fn((jobId: string) => Promise.resolve([createMockJobEvent({ jobId })])),
		kill: vi.fn((id: string) =>
			Promise.resolve(createMockJob({ id, status: 'killed', reason: 'killed by admin' }))
		),
		listAll: vi.fn().mockResolvedValue([createMockJob()]),
	}

	app.decorate('jobService', mock)
}

export default fp(mockPlugin, { name: '#internal/jobService' })

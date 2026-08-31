import fp from 'fastify-plugin'

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'

export const mockPreviewDatabaseUrl =
	'postgres://mf_app_job1:mock-password@db.example.com:5432/mf_app_job1?sslmode=no-verify'

const mockPlugin: FastifyPluginAsync = async app => {
	const mock: FastifyInstance['previewDbService'] = {
		provision: vi.fn().mockResolvedValue({ databaseUrl: mockPreviewDatabaseUrl }),
	}
	app.decorate('previewDbService', mock)
}

export default fp(mockPlugin, { name: '#internal/previewDbService' })

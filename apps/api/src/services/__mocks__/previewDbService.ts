import fp from 'fastify-plugin'

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import type { PreviewDatabaseDump } from '#/services/previewDbService.ts'

export const mockPreviewDatabaseUrl =
	'postgres://mf_app_job1:mock-password@db.example.com:5432/mf_app_job1?sslmode=no-verify'

export const createMockDatabaseDump = (
	overrides?: Partial<PreviewDatabaseDump>
): PreviewDatabaseDump => ({
	database: 'mf_app_job1',
	exportedAt: '2026-09-02T12:00:00.000Z',
	tables: [
		{
			table: 'bookings',
			columns: ['id', 'member'],
			rows: [{ id: 1, member: 'anna' }],
			truncated: false,
		},
	],
	...overrides,
})

const mockPlugin: FastifyPluginAsync = async app => {
	const mock: FastifyInstance['previewDbService'] = {
		provision: vi.fn().mockResolvedValue({ databaseUrl: mockPreviewDatabaseUrl }),
		dump: vi.fn().mockResolvedValue(createMockDatabaseDump()),
		teardown: vi.fn().mockResolvedValue({ database: 'deleted', role: 'deleted' }),
	}
	app.decorate('previewDbService', mock)
}

export default fp(mockPlugin, { name: '#internal/previewDbService' })

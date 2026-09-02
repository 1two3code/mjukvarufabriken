import fp from 'fastify-plugin'
import { mergeDeep } from '@mf/utils/object'

import { mockPresignedUrl } from '#/plugins/__mocks__/s3.ts'

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import type { PartialDeep } from 'type-fest'
import type { OrderExport, OrderExportResponse } from '@mf/models'

const defaultExport: OrderExport = {
	orderId: 'order-1',
	jobId: 'job-1',
	key: 'deliverables/job-1/export/',
	status: 'done',
	files: [
		{ name: 'repo.zip', key: 'deliverables/job-1/export/repo.zip', size: 1024 },
		{ name: 'database.json', key: 'deliverables/job-1/export/database.json', size: 256 },
	],
	createdAt: '2026-09-02T12:00:00.000Z',
	finishedAt: '2026-09-02T12:00:05.000Z',
}

export const createMockOrderExport = (overrides?: PartialDeep<OrderExport>): OrderExport =>
	mergeDeep(defaultExport, overrides)

export const createMockOrderExportResponse = (
	overrides?: PartialDeep<OrderExport>
): OrderExportResponse => {
	const exported = createMockOrderExport(overrides)
	return {
		...exported,
		files: exported.files.map(file => ({
			...file,
			url: mockPresignedUrl(file.key),
			expiresAt: '2026-09-02T12:15:00.000Z',
		})),
	}
}

const mockPlugin: FastifyPluginAsync = async app => {
	const mock: FastifyInstance['exportService'] = {
		finalExport: vi.fn((orderId: string) => Promise.resolve(createMockOrderExport({ orderId }))),
		getForOrder: vi.fn((orderId: string) =>
			Promise.resolve(createMockOrderExportResponse({ orderId }))
		),
		writeDeletionCertificate: vi.fn((orderId: string) =>
			Promise.resolve(createMockOrderExport({ orderId }))
		),
	}
	app.decorate('exportService', mock)
}

export default fp(mockPlugin, { name: '#internal/exportService' })

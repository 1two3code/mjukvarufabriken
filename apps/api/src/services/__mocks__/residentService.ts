import fp from 'fastify-plugin'
import { mergeDeep } from '@mf/utils/object'

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import type { PartialDeep } from 'type-fest'
import type { ResidentUsageRecord } from '@mf/models'

const defaultUsageRecord: ResidentUsageRecord = {
	installationId: 'acme-shop',
	repository: 'acme/shop',
	day: '2026-09-03',
	month: '2026-09',
	tokensByModel: {
		'claude-sonnet-5': {
			inputTokens: 1_000_000,
			outputTokens: 100_000,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			budgetTokens: 1_100_000,
		},
	},
	totalTokens: 1_100_000,
	tasks: { started: 2, succeeded: 1, failed: 1, pullRequestsOpened: 1 },
	cost: { listPriceUsd: 4.5, markup: 1.5, billableUsd: 6.75 },
	monthlyCap: { tokens: 50_000_000, usedTokens: 1_100_000 },
	generatedAt: '2026-09-03T23:59:00.000Z',
}

export const createMockResidentUsageRecord = (
	overrides?: PartialDeep<ResidentUsageRecord>
): ResidentUsageRecord => mergeDeep(defaultUsageRecord, overrides)

const mockPlugin: FastifyPluginAsync = async app => {
	const mock: FastifyInstance['residentService'] = {
		authenticate: vi.fn().mockResolvedValue('acme-shop'),
		recordUsage: vi.fn((record: ResidentUsageRecord) =>
			Promise.resolve({ id: `${record.installationId}/${record.day}`, stored: true as const })
		),
		listUsage: vi.fn().mockResolvedValue([createMockResidentUsageRecord()]),
	}

	app.decorate('residentService', mock)
}

export default fp(mockPlugin, { name: '#internal/residentService' })

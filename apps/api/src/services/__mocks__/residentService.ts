import fp from 'fastify-plugin'
import { mergeDeep } from '@mf/utils/object'

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import type { PartialDeep } from 'type-fest'
import type { ResidentInstallation, ResidentUsageRecord, ResidentUsageSummary } from '@mf/models'

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

const defaultInstallation: ResidentInstallation = {
	id: 'acme-shop',
	orgId: 'org-1',
	billingCustomerId: 'cus_acme',
	createdAt: '2026-09-01T00:00:00.000Z',
	updatedAt: '2026-09-01T00:00:00.000Z',
}

export const createMockResidentInstallation = (
	overrides?: PartialDeep<ResidentInstallation>
): ResidentInstallation => mergeDeep(defaultInstallation, overrides)

const defaultSummary: ResidentUsageSummary = {
	installationId: 'acme-shop',
	orgId: 'org-1',
	repository: 'acme/shop',
	month: '2026-09',
	days: 3,
	totalTokens: 3_300_000,
	listPriceUsd: 13.5,
	billableUsd: 20.25,
	tasks: { started: 6, succeeded: 3, failed: 3, pullRequestsOpened: 3 },
	monthlyCap: { tokens: 50_000_000, usedTokens: 3_300_000 },
}

export const createMockResidentUsageSummary = (
	overrides?: PartialDeep<ResidentUsageSummary>
): ResidentUsageSummary => mergeDeep(defaultSummary, overrides)

const mockPlugin: FastifyPluginAsync = async app => {
	const mock: FastifyInstance['residentService'] = {
		authenticate: vi.fn().mockResolvedValue('acme-shop'),
		recordUsage: vi.fn((record: ResidentUsageRecord) =>
			Promise.resolve({ id: `${record.installationId}/${record.day}`, stored: true as const })
		),
		listUsage: vi.fn().mockResolvedValue([createMockResidentUsageRecord()]),
		summarizeUsage: vi.fn().mockResolvedValue([createMockResidentUsageSummary()]),
		listInstallations: vi.fn().mockResolvedValue([createMockResidentInstallation()]),
		upsertInstallation: vi.fn((id: string, update) =>
			Promise.resolve(
				createMockResidentInstallation({
					id,
					orgId: update.orgId ?? undefined,
					billingCustomerId: update.billingCustomerId ?? undefined,
				})
			)
		),
	}

	app.decorate('residentService', mock)
}

export default fp(mockPlugin, { name: '#internal/residentService' })

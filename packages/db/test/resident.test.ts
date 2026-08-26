import { createMemoryRepositories } from '#/memory.ts'
import {
	toResidentInstallation,
	toResidentUsageReport,
	toResidentUsageSummary,
} from '#/resident.ts'

import type { ResidentUsageRecord } from '@mf/models'
import type { Repositories } from '#/repositories.ts'

const at = new Date('2026-09-03T10:00:00.000Z')

const record = (overrides: Partial<ResidentUsageRecord> = {}): ResidentUsageRecord => ({
	installationId: 'acme-shop',
	repository: 'acme/shop',
	day: '2026-09-03',
	month: '2026-09',
	tokensByModel: {},
	totalTokens: 1_000,
	tasks: { started: 2, succeeded: 1, failed: 1, pullRequestsOpened: 1 },
	cost: { listPriceUsd: 4, markup: 1.5, billableUsd: 6 },
	monthlyCap: { tokens: 50_000, usedTokens: 1_000 },
	generatedAt: '2026-09-03T23:59:00.000Z',
	...overrides,
})

describe('resident repository (memory)', () => {
	let repos: Repositories

	beforeEach(() => {
		repos = createMemoryRepositories()
	})

	it('Creates the installation on the first record and replaces a day reported twice', async () => {
		await repos.resident.upsertUsage(record())
		await repos.resident.upsertUsage(record({ totalTokens: 2_000 }))

		const installation = await repos.resident.getInstallation('acme-shop')
		expect(installation).toMatchObject({ id: 'acme-shop' })
		expect(installation?.orgId).toBeUndefined()
		const stored = await repos.resident.listUsage({ installationId: 'acme-shop' })
		expect(stored.map(entry => [entry.day, entry.totalTokens])).toEqual([['2026-09-03', 2_000]])
	})

	it('Summarises per installation and month with the cap view from the latest day', async () => {
		await repos.resident.upsertUsage(
			record({ day: '2026-09-01', monthlyCap: { tokens: 50_000, usedTokens: 1_000 } })
		)
		await repos.resident.upsertUsage(
			record({
				day: '2026-09-02',
				totalTokens: 500,
				cost: { listPriceUsd: 2, markup: 1.5, billableUsd: 3 },
				monthlyCap: { tokens: 50_000, usedTokens: 1_500 },
			})
		)
		await repos.resident.upsertUsage(record({ day: '2026-08-31', month: '2026-08' }))
		await repos.resident.upsertUsage(
			record({ installationId: 'beta-crm', repository: 'beta/crm', day: '2026-09-02' })
		)
		await repos.resident.upsertInstallation({ id: 'acme-shop', orgId: 'org-1' })

		const summaries = await repos.resident.summarizeUsage({ month: '2026-09' })

		expect(summaries.map(summary => summary.installationId)).toEqual(['acme-shop', 'beta-crm'])
		expect(summaries[0]).toEqual({
			installationId: 'acme-shop',
			orgId: 'org-1',
			repository: 'acme/shop',
			month: '2026-09',
			days: 2,
			totalTokens: 1_500,
			listPriceUsd: 6,
			billableUsd: 9,
			tasks: { started: 4, succeeded: 2, failed: 2, pullRequestsOpened: 2 },
			monthlyCap: { tokens: 50_000, usedTokens: 1_500 },
		})
		const all = await repos.resident.summarizeUsage()
		expect(all.map(summary => summary.month)).toEqual(['2026-09', '2026-09', '2026-08'])
	})

	it('Keeps or clears installation fields depending on undefined vs null', async () => {
		await repos.resident.upsertInstallation({
			id: 'acme-shop',
			orgId: 'org-1',
			billingCustomerId: 'cus_1',
		})
		await expect(
			repos.resident.upsertInstallation({ id: 'acme-shop', billingCustomerId: null })
		).resolves.toMatchObject({ orgId: 'org-1', billingCustomerId: undefined })
		await expect(repos.resident.listInstallations()).resolves.toHaveLength(1)
	})

	it('Stores the cumulative usage report per installation and month', async () => {
		await repos.resident.upsertUsage(record())
		await repos.resident.upsertUsageReport({
			installationId: 'acme-shop',
			month: '2026-09',
			usdCents: 600,
			provider: 'fake',
			reference: 'r1',
		})
		await repos.resident.upsertUsageReport({
			installationId: 'acme-shop',
			month: '2026-09',
			usdCents: 900,
			provider: 'fake',
			reference: 'r2',
		})

		await expect(repos.resident.getUsageReport('acme-shop', '2026-09')).resolves.toMatchObject({
			usdCents: 900,
			reference: 'r2',
		})
		await expect(repos.resident.getUsageReport('acme-shop', '2026-10')).resolves.toBeUndefined()
		await expect(repos.resident.listUsageReports('2026-09')).resolves.toHaveLength(1)
	})
})

describe('resident row mapping', () => {
	it('Maps installation, summary and report rows with numeric strings converted', () => {
		expect(
			toResidentInstallation({
				id: 'a',
				org_id: null,
				billing_customer_id: 'cus_1',
				created_at: at,
				updated_at: at,
			})
		).toEqual({
			id: 'a',
			orgId: undefined,
			billingCustomerId: 'cus_1',
			createdAt: at.toISOString(),
			updatedAt: at.toISOString(),
		})
		expect(
			toResidentUsageSummary({
				installation_id: 'a',
				org_id: 'org',
				month: '2026-09',
				repository: 'a/b',
				days: '2',
				total_tokens: '1500',
				list_price_usd: 6,
				billable_usd: 9,
				tasks_started: '4',
				tasks_succeeded: '2',
				tasks_failed: '2',
				pull_requests_opened: '2',
				cap_tokens: '50000',
				cap_used_tokens: '1500',
			})
		).toMatchObject({
			days: 2,
			totalTokens: 1_500,
			billableUsd: 9,
			monthlyCap: { tokens: 50_000, usedTokens: 1_500 },
		})
		expect(
			toResidentUsageReport({
				installation_id: 'a',
				month: '2026-09',
				usd_cents: '900',
				provider: 'stripe',
				reference: null,
				reported_at: at,
			})
		).toEqual({
			installationId: 'a',
			month: '2026-09',
			usdCents: 900,
			provider: 'stripe',
			reference: undefined,
			reportedAt: at.toISOString(),
		})
	})
})

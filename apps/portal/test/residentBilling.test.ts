import { billingStatusOf, usageMonths } from '#/features/admin/residentBilling.ts'

import type { ResidentInstallation, ResidentUsageSummary } from '@mf/models'

describe('Resident billing status', () => {
	const now = '2026-08-27T00:00:00.000Z'
	const installation: ResidentInstallation = {
		id: 'inst',
		orgId: 'org',
		billingCustomerId: 'cus_1',
		createdAt: now,
		updatedAt: now,
	}
	const usage = (overrides: Partial<ResidentUsageSummary>): ResidentUsageSummary => ({
		installationId: 'inst',
		repository: 'a/b',
		month: '2026-08',
		days: 1,
		totalTokens: 1000,
		listPriceUsd: 10,
		billableUsd: 15,
		tasks: { started: 1, succeeded: 1, failed: 0, pullRequestsOpened: 1 },
		monthlyCap: { tokens: 10_000, usedTokens: 1000 },
		...overrides,
	})
	const report = (usdCents: number, pendingAt?: string) => ({
		installationId: 'inst',
		month: '2026-08',
		usdCents,
		provider: 'fake' as const,
		reportedAt: now,
		pendingAt,
	})

	it.each([
		['nothing', usage({ billableUsd: 0 }), installation, 0],
		['noCustomer', usage({}), { ...installation, billingCustomerId: undefined }, 1500],
		['noCustomer', usage({}), undefined, 1500],
		['unreported', usage({}), installation, 1500],
		['inProgress', usage({ report: report(0, now) }), installation, 1500],
		['partial', usage({ report: report(1000) }), installation, 500],
		['reported', usage({ report: report(1500) }), installation, 0],
		['overreported', usage({ report: report(2000) }), installation, 0],
	] as const)('%s', (status, row, installationRow, unbilledUsdCents) => {
		expect(billingStatusOf(row, installationRow)).toEqual({ status, unbilledUsdCents })
	})

	it('Lists the months newest first without duplicates', () => {
		const rows = [usage({ month: '2026-07' }), usage({ month: '2026-08' }), usage({ month: '2026-07' })]
		expect(usageMonths(rows)).toEqual(['2026-08', '2026-07'])
	})
})

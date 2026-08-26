import {
	billingRunTone,
	billingStatusOf,
	filterUsageMonth,
	summarizeBillingRun,
	usageMonths,
	usageReportInFlightMs,
} from '#/features/admin/residentBilling.ts'

import type {
	ResidentBillingRunResponse,
	ResidentInstallation,
	ResidentUsageSummary,
} from '@mf/models'

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
		expect(billingStatusOf(row, installationRow, Date.parse(now))).toEqual({
			status,
			unbilledUsdCents,
		})
	})

	it('Treats a reservation older than the in-flight window as a run that died', () => {
		const row = usage({ report: report(1000, now) })
		const later = Date.parse(now) + usageReportInFlightMs
		expect(billingStatusOf(row, installation, later - 1).status).toBe('inProgress')
		expect(billingStatusOf(row, installation, later)).toEqual({
			status: 'partial',
			unbilledUsdCents: 500,
		})
	})

	it('Filters the rows by month client-side, all rows without a month', () => {
		const rows = [usage({ month: '2026-07' }), usage({ month: '2026-08' })]
		expect(filterUsageMonth(rows, '2026-07')).toEqual([rows[0]])
		expect(filterUsageMonth(rows, '')).toBe(rows)
	})

	it('Lists the months newest first without duplicates', () => {
		const rows = [
			usage({ month: '2026-07' }),
			usage({ month: '2026-08' }),
			usage({ month: '2026-07' }),
		]
		expect(usageMonths(rows)).toEqual(['2026-08', '2026-07'])
	})
})

describe('Billing run toast', () => {
	const run = (
		...outcomes: ResidentBillingRunResponse['results'][number]['outcome'][]
	): ResidentBillingRunResponse => ({
		month: '2026-08',
		provider: 'stripe',
		results: outcomes.map(outcome => ({
			installationId: 'inst',
			outcome,
			usdCents: 0,
			totalUsdCents: 0,
		})),
	})

	it.each([
		['success', run('reported', 'failed')],
		['info', run('unchanged', 'unchanged')],
		['info', run()],
		['error', run('failed')],
		['error', run('no_customer', 'unchanged')],
		['error', run('in_progress')],
		['error', run('overreported')],
	] as const)('%s', (tone, results) => {
		expect(billingRunTone(results)).toBe(tone)
	})

	it('Counts the outcomes for the summary', () => {
		expect(summarizeBillingRun(run('reported', 'unchanged', 'reported'))).toBe(
			'reported: 2, unchanged: 1'
		)
		expect(summarizeBillingRun(run())).toBe('')
	})
})

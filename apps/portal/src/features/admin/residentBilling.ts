import { usdCentsOf } from '@mf/models'

import type { ResidentInstallation, ResidentUsageSummary } from '@mf/models'

export const residentBillingStatus = [
	'nothing',
	'noCustomer',
	'unreported',
	'inProgress',
	'partial',
	'reported',
	'overreported',
] as const
export type ResidentBillingStatus = (typeof residentBillingStatus)[number]

/**
 * Where one installation's month stands against the payment provider: what the api has
 * reported so far (`report.usdCents`, cumulative) versus what the month is worth now.
 */
export const billingStatusOf = (
	usage: ResidentUsageSummary,
	installation: ResidentInstallation | undefined
): { status: ResidentBillingStatus; unbilledUsdCents: number } => {
	const billableCents = usdCentsOf(usage.billableUsd)
	const reportedCents = usage.report?.usdCents ?? 0
	const unbilledUsdCents = Math.max(0, billableCents - reportedCents)

	if (usage.report?.pendingAt) return { status: 'inProgress', unbilledUsdCents }
	if (billableCents === 0 && !usage.report) return { status: 'nothing', unbilledUsdCents }
	if (!installation?.billingCustomerId && unbilledUsdCents > 0) {
		return { status: 'noCustomer', unbilledUsdCents }
	}
	if (!usage.report) return { status: 'unreported', unbilledUsdCents }
	if (reportedCents > billableCents) return { status: 'overreported', unbilledUsdCents }
	if (reportedCents < billableCents) return { status: 'partial', unbilledUsdCents }
	return { status: 'reported', unbilledUsdCents }
}

export const formatUsd = (value: number, language: string) =>
	value.toLocaleString(language, { style: 'currency', currency: 'USD' })

/** Months with usage, newest first */
export const usageMonths = (usage: ResidentUsageSummary[]) =>
	[...new Set(usage.map(row => row.month))].toSorted().toReversed()

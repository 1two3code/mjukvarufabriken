import { usdCentsOf } from '@mf/models'

import type {
	ResidentBillingRunResponse,
	ResidentInstallation,
	ResidentUsageSummary,
} from '@mf/models'
import type { ToastType } from '#/features/toasts/toastsSlice.ts'

/**
 * How long the api treats a reserved-but-unconfirmed report as in flight
 * (`usageReportInFlightMs` in apps/api paymentService) before the next run retries it. A
 * `pendingAt` older than this is a run that died — the month needs billing again.
 */
export const usageReportInFlightMs = 5 * 60_000

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
	installation: ResidentInstallation | undefined,
	now = Date.now()
): { status: ResidentBillingStatus; unbilledUsdCents: number } => {
	const billableCents = usdCentsOf(usage.billableUsd)
	const reportedCents = usage.report?.usdCents ?? 0
	const unbilledUsdCents = Math.max(0, billableCents - reportedCents)

	if (isReportInFlight(usage, now)) return { status: 'inProgress', unbilledUsdCents }
	if (billableCents === 0 && !usage.report) return { status: 'nothing', unbilledUsdCents }
	if (!installation?.billingCustomerId && unbilledUsdCents > 0) {
		return { status: 'noCustomer', unbilledUsdCents }
	}
	if (!usage.report) return { status: 'unreported', unbilledUsdCents }
	if (reportedCents > billableCents) return { status: 'overreported', unbilledUsdCents }
	if (reportedCents < billableCents) return { status: 'partial', unbilledUsdCents }
	return { status: 'reported', unbilledUsdCents }
}

/** A reservation younger than the api's in-flight window; older ones are retried by the next run */
export const isReportInFlight = (usage: ResidentUsageSummary, now = Date.now()) => {
	const pendingAt = usage.report?.pendingAt
	return pendingAt !== undefined && now - Date.parse(pendingAt) < usageReportInFlightMs
}

export const formatUsd = (value: number, language: string) =>
	value.toLocaleString(language, { style: 'currency', currency: 'USD' })

/** Months with usage, newest first */
export const usageMonths = (usage: ResidentUsageSummary[]) =>
	[...new Set(usage.map(row => row.month))].toSorted().toReversed()

/** The rows of one month, or all of them when no month is picked (the api is fetched once) */
export const filterUsageMonth = (usage: ResidentUsageSummary[], month: string) =>
	month ? usage.filter(row => row.month === month) : usage

/** `reported: 2, unchanged: 1, …` for the toast after a billing run */
export const summarizeBillingRun = (run: ResidentBillingRunResponse) => {
	const counts = new Map<string, number>()
	for (const result of run.results) {
		counts.set(result.outcome, (counts.get(result.outcome) ?? 0) + 1)
	}
	return [...counts].map(([outcome, count]) => `${outcome}: ${count}`).join(', ')
}

/**
 * How a billing run went, for the toast: something was reported → success; nothing to
 * report (unchanged, or no installations) → info; nothing reported although something
 * should have been (failed, no customer, in progress, over-reported) → error.
 */
export const billingRunTone = (run: ResidentBillingRunResponse): ToastType => {
	const outcomes = new Set(run.results.map(result => result.outcome))
	if (outcomes.has('reported')) return 'success'
	if ([...outcomes].every(outcome => outcome === 'unchanged')) return 'info'
	return 'error'
}

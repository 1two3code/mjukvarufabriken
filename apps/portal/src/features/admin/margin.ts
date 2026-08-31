import { residentUsageMarkup } from '@mf/models'

import type { CustomerRevenue, Job, Order, Org, ResidentUsageSummary } from '@mf/models'

/**
 * M12 margin calculator (PLAN.md M12): folds what the api already exposes — per-job real cost
 * (`jobs.cost_usd`, NEVER the weighted `tokensUsed` budget metric), the phase-1 shared-infra
 * allocation, paid build fees and resident usage — into a per-customer margin view and an
 * aggregate P&L over time, priced at the revenue model decided 2026-08-31
 * (docs/backlog/strategy-2026-08-31.md): 600 kr/mo managed subscription + resident tokens at
 * list ×1.5 + AWS passthrough +20 % + build fees per the ladder.
 *
 * Everything here is pure so it can be unit-tested and fed either live api data or the mock
 * customers (`mockMargin.ts`). Amounts ending in `Sek` are SEK ex moms; `Usd` are US dollars.
 */

// MARK: Assumptions

/**
 * The knobs of the model — every field here is read by the calculator, so editing one on the
 * page moves the figures. Only the token model prices behind `costUsd`/`listPriceUsd` are
 * backend-editable (the Pricing tab); these are what-if values, local to the page.
 */
export type MarginAssumptions = {
	/** Managed subscription, SEK ex moms per month (decided 2026-08-31) */
	subscriptionSekPerMonth: number
	/** Resident revenue modeled as Anthropic list price × this (decided ×1.5, `residentUsageMarkup`) */
	tokenMarkup: number
	/** Exchange rate used to fold USD figures into the SEK view */
	sekPerUsd: number
	/** Monthly shared-infra allocation per active customer, USD (api phase-1 estimate, overridable) */
	infraPerOrgMonthlyUsd: number
}

export const defaultAssumptions: Omit<MarginAssumptions, 'infraPerOrgMonthlyUsd'> = {
	subscriptionSekPerMonth: 600,
	tokenMarkup: residentUsageMarkup,
	sekPerUsd: 10.5,
}

/**
 * Decided AWS passthrough markup (+20 %, 2026-08-31) — a fact, NOT a `MarginAssumptions` knob:
 * there is no AWS cost feed yet (M12 phase 2), so no computation reads it and an editable field
 * would be a dead control. It moves here the day passthrough cost data exists.
 */
export const awsPassthroughMarkup = 1.2

// MARK: Input shapes

/** The slices of the api responses the calculator reads (mocks provide exactly these) */
export type MarginJob = Pick<Job, 'id' | 'orgId' | 'costUsd' | 'createdAt'>
export type MarginOrder = Pick<
	Order,
	'id' | 'orgId' | 'status' | 'priceSek' | 'lifecycle' | 'frozenAt' | 'createdAt'
>
export type MarginUsage = Pick<
	ResidentUsageSummary,
	'orgId' | 'month' | 'billableUsd' | 'listPriceUsd'
>

export type MarginInputs = {
	orgs: Org[]
	jobs: MarginJob[]
	orders: MarginOrder[]
	/** Real paid build fees + resident billables per org (`GET /bff/admin/margin/revenue`) */
	revenue: CustomerRevenue[]
	usage: MarginUsage[]
	assumptions: MarginAssumptions
}

// MARK: Helpers

const round2 = (value: number) => Math.round(value * 100) / 100

/** `YYYY-MM` (UTC) of an ISO datetime */
export const monthOf = (iso: string) => iso.slice(0, 7)

/** Whole-SEK currency formatting — the model's precision doesn't warrant öre */
export const formatSek = (value: number, language: string) =>
	value.toLocaleString(language, { style: 'currency', currency: 'SEK', maximumFractionDigits: 0 })

/** `YYYY-MM` (UTC) shifted by `shift` months from `now` */
export const shiftMonth = (now: Date, shift: number) => {
	const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + shift, 1))
	return date.toISOString().slice(0, 7)
}

/**
 * Build compute cost per org from the per-job real USD spend. Reads `costUsd` ONLY — the
 * weighted `tokensUsed` budget metric reads ~8× low vs. real spend and must never be used as
 * cost (PLAN.md M12). Jobs from before migration 0018 carry no `costUsd` and count as 0.
 */
export const buildCostUsdByOrg = (jobs: MarginJob[]) => {
	const costs = new Map<string, number>()
	for (const job of jobs) {
		costs.set(job.orgId, round2((costs.get(job.orgId) ?? 0) + (job.costUsd ?? 0)))
	}
	return costs
}

/** Orders whose build fee counts as revenue: the deposit is paid (or the build was started) */
const revenueOrderStatus = ['deposit_paid', 'building', 'awaiting_approval', 'delivered', 'paid']
export const isRevenueOrder = (order: MarginOrder) => revenueOrderStatus.includes(order.status)

/** An order whose delivery is live: the managed subscription is modeled as running */
const subscribedOrderStatus = ['delivered', 'paid']
export const isSubscribedOrder = (order: MarginOrder) =>
	subscribedOrderStatus.includes(order.status) && order.lifecycle === 'active'

/** The month an order's revenue/subscription is recognized in: frozen (build start) or created */
export const orderMonth = (order: MarginOrder) => monthOf(order.frozenAt ?? order.createdAt)

// MARK: Per-customer margin

export type CustomerMarginRow = {
	/** Org id (doubles as the table row id) */
	id: string
	orgName: string
	/** Paid build fees to date (real payments, from the revenue endpoint) */
	buildFeeSek: number
	/** Resident revenue to date: list price × the markup knob (= the api's billed figure at ×1.5) */
	residentRevenueSek: number
	/** Build compute to date (`jobs.cost_usd`), folded to SEK */
	buildCostSek: number
	/** Our resident token cost to date (Anthropic list price), folded to SEK */
	residentCostSek: number
	revenueSek: number
	costSek: number
	marginSek: number
	/** Margin as a share of revenue; undefined when there is no revenue yet */
	marginPct?: number
	/** Modeled monthly recurring revenue: the managed subscription while a delivery is live */
	subscriptionSekPerMonth: number
	/** Monthly shared-infra allocation while the org is served, folded to SEK */
	infraSekPerMonth: number
	/** Modeled monthly run-rate: subscription − infra allocation */
	monthlyMarginSek: number
}

/**
 * One margin row per org: real one-time figures to date (build fees vs. build compute, resident
 * billed vs. resident list cost) plus the modeled monthly run-rate (subscription vs. the infra
 * allocation). Hosting/SLA/further-dev revenue are carried by the api but 0 until those payment
 * kinds exist. Resident revenue is modeled from the usage rows' `listPriceUsd` × the
 * `tokenMarkup` knob so the what-if actually moves the figures — at the decided ×1.5 it equals
 * the api's real billed figure (`residentBillableUsd`, backend-enforced as list ×
 * `residentUsageMarkup`), which therefore stays unread here.
 */
export const customerMarginRows = (inputs: MarginInputs): CustomerMarginRow[] => {
	const { orgs, jobs, orders, revenue, usage, assumptions } = inputs
	const buildCosts = buildCostUsdByOrg(jobs)
	const revenueByOrg = new Map(revenue.map(row => [row.orgId, row]))
	const listCostByOrg = new Map<string, number>()
	for (const row of usage) {
		if (!row.orgId) continue
		listCostByOrg.set(row.orgId, (listCostByOrg.get(row.orgId) ?? 0) + row.listPriceUsd)
	}

	const { sekPerUsd, tokenMarkup } = assumptions
	return orgs.map(org => {
		const orgRevenue = revenueByOrg.get(org.id)
		const buildFeeSek =
			(orgRevenue?.buildFeeSek ?? 0) +
			(orgRevenue?.hostingSek ?? 0) +
			(orgRevenue?.slaSek ?? 0) +
			(orgRevenue?.furtherDevSek ?? 0)
		const listCostUsd = listCostByOrg.get(org.id) ?? 0
		const residentRevenueSek = round2(listCostUsd * tokenMarkup * sekPerUsd)
		const buildCostSek = round2((buildCosts.get(org.id) ?? 0) * sekPerUsd)
		const residentCostSek = round2(listCostUsd * sekPerUsd)

		const revenueSek = round2(buildFeeSek + residentRevenueSek)
		const costSek = round2(buildCostSek + residentCostSek)
		const marginSek = round2(revenueSek - costSek)

		const subscribed = orders.some(order => order.orgId === org.id && isSubscribedOrder(order))
		const subscriptionSekPerMonth = subscribed ? assumptions.subscriptionSekPerMonth : 0
		const infraSekPerMonth = subscribed
			? round2(assumptions.infraPerOrgMonthlyUsd * sekPerUsd)
			: 0

		return {
			id: org.id,
			orgName: org.name,
			buildFeeSek,
			residentRevenueSek,
			buildCostSek,
			residentCostSek,
			revenueSek,
			costSek,
			marginSek,
			...(revenueSek > 0 && { marginPct: Math.round((marginSek / revenueSek) * 100) }),
			subscriptionSekPerMonth,
			infraSekPerMonth,
			monthlyMarginSek: round2(subscriptionSekPerMonth - infraSekPerMonth),
		}
	})
}

// MARK: Aggregate P&L over time

export type PnlMonthRow = {
	/** `YYYY-MM` (doubles as the table row id) */
	id: string
	/** Build fees recognized this month (modeled: `priceSek` at the order's frozen month) */
	buildFeeSek: number
	/** Modeled subscriptions running this month × the subscription price */
	subscriptionSek: number
	/** Resident revenue this month: list price × the markup knob (= billed at ×1.5), in SEK */
	residentRevenueSek: number
	revenueSek: number
	/** Build compute this month (`jobs.cost_usd`), folded to SEK */
	buildCostSek: number
	/** Our resident token cost this month (Anthropic list price), folded to SEK */
	residentCostSek: number
	/** The whole shared-infra estimate — the platform runs every month regardless of customers */
	infraSek: number
	costSek: number
	marginSek: number
}

/**
 * Aggregate P&L per month, oldest first, from the first month with any activity through the
 * current month. Build-fee recognition is modeled from orders (`priceSek` at the frozen month) —
 * the api's paid-payments figure has no time axis yet — and subscriptions are modeled from the
 * delivery month on, so this is a shape-of-the-business view, not bookkeeping.
 */
export const monthlyPnl = (
	inputs: MarginInputs & { infraTotalMonthlyUsd: number; now?: Date }
): PnlMonthRow[] => {
	const { jobs, orders, usage, assumptions, infraTotalMonthlyUsd } = inputs
	const now = inputs.now ?? new Date()
	const { sekPerUsd, tokenMarkup } = assumptions

	const revenueOrders = orders.filter(isRevenueOrder)
	const subscriptionStarts = orders.filter(isSubscribedOrder).map(orderMonth)

	const activityMonths = [
		...jobs.map(job => monthOf(job.createdAt)),
		...revenueOrders.map(orderMonth),
		...usage.map(row => row.month),
	]
	if (activityMonths.length === 0) return []

	const currentMonth = shiftMonth(now, 0)
	const months: string[] = []
	for (let month = activityMonths.toSorted()[0]!; month <= currentMonth; ) {
		months.push(month)
		month = shiftMonth(new Date(`${month}-01T00:00:00Z`), 1)
	}

	return months.map(month => {
		const buildFeeSek = revenueOrders
			.filter(order => orderMonth(order) === month)
			.reduce((sum, order) => sum + (order.priceSek ?? 0), 0)
		const subscriptions = subscriptionStarts.filter(start => start <= month).length
		const subscriptionSek = subscriptions * assumptions.subscriptionSekPerMonth
		const monthUsage = usage.filter(row => row.month === month)
		const monthListUsd = monthUsage.reduce((sum, row) => sum + row.listPriceUsd, 0)
		const residentRevenueSek = round2(monthListUsd * tokenMarkup * sekPerUsd)
		const residentCostSek = round2(monthListUsd * sekPerUsd)
		const buildCostSek = round2(
			jobs
				.filter(job => monthOf(job.createdAt) === month)
				.reduce((sum, job) => sum + (job.costUsd ?? 0), 0) * sekPerUsd
		)
		const infraSek = round2(infraTotalMonthlyUsd * sekPerUsd)

		const revenueSek = round2(buildFeeSek + subscriptionSek + residentRevenueSek)
		const costSek = round2(buildCostSek + residentCostSek + infraSek)
		return {
			id: month,
			buildFeeSek,
			subscriptionSek,
			residentRevenueSek,
			revenueSek,
			buildCostSek,
			residentCostSek,
			infraSek,
			costSek,
			marginSek: round2(revenueSek - costSek),
		}
	})
}

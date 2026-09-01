import { allocateInfraCost } from '@mf/models'

import { shiftMonth } from '#/features/admin/margin.ts'

import type { CustomerRevenue, InfraCostAllocation, Org } from '@mf/models'
import type { MarginJob, MarginOrder, MarginUsage } from '#/features/admin/margin.ts'

/**
 * Mock customers for the M12 margin view (PLAN.md M12: "mock customers to start so the shape is
 * visible before any real order exists"). Four orgs spanning the decided pricing ladder
 * (docs/backlog/strategy-2026-08-31.md):
 *  - a voucher demo that converted to a real build + managed subscription + resident usage
 *  - a voucher demo that did not convert
 *  - a real build + subscription without resident usage
 *  - a spec chat that never ordered (the zero row)
 * Dates are relative to `now` so the P&L always shows a live-looking recent window. Client-side
 * only — nothing is seeded into the database.
 */

export type MockMarginData = {
	orgs: Org[]
	jobs: MarginJob[]
	orders: MarginOrder[]
	revenue: CustomerRevenue[]
	usage: MarginUsage[]
	infra: InfraCostAllocation
}

const revenueRow = (
	orgId: string,
	orgName: string,
	buildFeeSek: number,
	residentBillableUsd: number
): CustomerRevenue => ({
	orgId,
	orgName,
	buildFeeSek,
	hostingSek: 0,
	slaSek: 0,
	furtherDevSek: 0,
	residentBillableUsd,
})

/** Resident month: our cost is Anthropic list price; billed at list × 1.5 (`residentUsageMarkup`) */
const usageRow = (orgId: string, month: string, listPriceUsd: number): MarginUsage => ({
	orgId,
	month,
	listPriceUsd,
	billableUsd: Math.round(listPriceUsd * 1.5 * 100) / 100,
})

export const mockMarginData = (now = new Date()): MockMarginData => {
	const month = (shift: number) => shiftMonth(now, shift)
	const at = (shift: number, day: string) => `${month(shift)}-${day}T12:00:00.000Z`

	const orgs: Org[] = [
		{ id: 'mock-bageri', name: 'Bageriet Solrosen AB', createdAt: at(-4, '03') },
		{ id: 'mock-hantverk', name: 'Hantverkslaget Nord AB', createdAt: at(-2, '11') },
		{ id: 'mock-verkstad', name: 'Verkstad Söder AB', createdAt: at(-1, '07') },
		{ id: 'mock-forening', name: 'Föreningen Ängsholmen', createdAt: at(0, '02') },
	]

	// Voucher demos cost us ≈ $6–8 in tokens (≈ 60–80 kr, per the strategy note); real builds more
	const jobs: MarginJob[] = [
		{ id: 'mock-job-1', orgId: 'mock-bageri', costUsd: 7.2, createdAt: at(-4, '05') },
		{ id: 'mock-job-2', orgId: 'mock-bageri', costUsd: 24.8, createdAt: at(-3, '12') },
		{ id: 'mock-job-3', orgId: 'mock-bageri', costUsd: 3.1, createdAt: at(-2, '20') },
		{ id: 'mock-job-4', orgId: 'mock-hantverk', costUsd: 6.4, createdAt: at(-2, '14') },
		{ id: 'mock-job-5', orgId: 'mock-verkstad', costUsd: 19.5, createdAt: at(-1, '09') },
	]

	const orders: MarginOrder[] = [
		{
			id: 'mock-order-1',
			orgId: 'mock-bageri',
			status: 'paid',
			priceSek: 500,
			lifecycle: 'torn_down',
			frozenAt: at(-4, '04'),
			createdAt: at(-4, '03'),
		},
		{
			id: 'mock-order-2',
			orgId: 'mock-bageri',
			status: 'paid',
			priceSek: 4500,
			lifecycle: 'active',
			frozenAt: at(-3, '10'),
			createdAt: at(-3, '08'),
		},
		{
			id: 'mock-order-3',
			orgId: 'mock-hantverk',
			status: 'paid',
			priceSek: 500,
			lifecycle: 'torn_down',
			frozenAt: at(-2, '13'),
			createdAt: at(-2, '11'),
		},
		{
			id: 'mock-order-4',
			orgId: 'mock-verkstad',
			status: 'delivered',
			priceSek: 3000,
			lifecycle: 'active',
			frozenAt: at(-1, '08'),
			createdAt: at(-1, '07'),
		},
		{
			id: 'mock-order-5',
			orgId: 'mock-forening',
			status: 'drafting',
			lifecycle: 'active',
			createdAt: at(0, '02'),
		},
	]

	const usage: MarginUsage[] = [
		usageRow('mock-bageri', month(-2), 8.1),
		usageRow('mock-bageri', month(-1), 12.4),
		usageRow('mock-bageri', month(0), 5.9),
	]

	const residentBillableOf = (orgId: string) =>
		Math.round(
			usage.filter(row => row.orgId === orgId).reduce((sum, row) => sum + row.billableUsd, 0) * 100
		) / 100

	// Build fees mirror the paid orders above so the per-customer and P&L views tell one story
	const revenue: CustomerRevenue[] = [
		revenueRow('mock-bageri', 'Bageriet Solrosen AB', 5000, residentBillableOf('mock-bageri')),
		revenueRow('mock-hantverk', 'Hantverkslaget Nord AB', 500, 0),
		revenueRow('mock-verkstad', 'Verkstad Söder AB', 3000, 0),
		revenueRow('mock-forening', 'Föreningen Ängsholmen', 0, 0),
	]

	// The same phase-1 allocation the api computes, over the two orgs with a live delivery
	const infra = allocateInfraCost(['mock-bageri', 'mock-verkstad'])

	return { orgs, jobs, orders, revenue, usage, infra }
}

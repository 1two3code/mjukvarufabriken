import { CustomerRevenueListResponseSchema } from '@mf/models'

import {
	buildCostUsdByOrg,
	customerMarginRows,
	defaultAssumptions,
	monthlyPnl,
	monthOf,
	shiftMonth,
} from '#/features/admin/margin.ts'
import { mockMarginData } from '#/features/admin/mockMargin.ts'

import type { MarginAssumptions, MarginInputs } from '#/features/admin/margin.ts'

const assumptions: MarginAssumptions = {
	subscriptionSekPerMonth: 600,
	tokenMarkup: 1.5,
	awsPassthroughMarkup: 1.2,
	sekPerUsd: 10,
	infraPerOrgMonthlyUsd: 20,
}

const now = new Date('2026-08-31T12:00:00Z')

describe('Margin calculator (M12)', () => {
	it('Sums build cost from costUsd only — never the weighted token budget metric', () => {
		const costs = buildCostUsdByOrg([
			{ id: 'a', orgId: 'org-1', costUsd: 7.25, createdAt: '2026-08-01T00:00:00Z' },
			{ id: 'b', orgId: 'org-1', costUsd: 2.75, createdAt: '2026-08-02T00:00:00Z' },
			// A pre-0018 job: no costUsd, whatever its (weighted) tokensUsed was — counts as 0
			{ id: 'c', orgId: 'org-1', createdAt: '2026-07-01T00:00:00Z' },
			{ id: 'd', orgId: 'org-2', costUsd: 5, createdAt: '2026-08-03T00:00:00Z' },
		])
		expect(costs.get('org-1')).toBe(10)
		expect(costs.get('org-2')).toBe(5)
	})

	it('Slices months in UTC and shifts across year boundaries', () => {
		expect(monthOf('2026-08-31T23:59:59.000Z')).toBe('2026-08')
		expect(shiftMonth(new Date('2026-01-15T00:00:00Z'), -2)).toBe('2025-11')
		expect(shiftMonth(new Date('2026-12-15T00:00:00Z'), 1)).toBe('2027-01')
	})

	it('Builds one margin row per org with real to-date and modeled monthly figures', () => {
		const inputs: MarginInputs = {
			orgs: [
				{ id: 'org-1', name: 'Acme AB', createdAt: '2026-06-01T00:00:00Z' },
				{ id: 'org-2', name: 'Beta AB', createdAt: '2026-08-01T00:00:00Z' },
			],
			jobs: [{ id: 'a', orgId: 'org-1', costUsd: 10, createdAt: '2026-07-05T00:00:00Z' }],
			orders: [
				{
					id: 'o1',
					orgId: 'org-1',
					status: 'paid',
					priceSek: 4500,
					lifecycle: 'active',
					frozenAt: '2026-07-03T00:00:00Z',
					createdAt: '2026-07-01T00:00:00Z',
				},
			],
			revenue: [
				{
					orgId: 'org-1',
					orgName: 'Acme AB',
					buildFeeSek: 4500,
					hostingSek: 0,
					slaSek: 0,
					furtherDevSek: 0,
					residentBillableUsd: 15,
				},
			],
			usage: [{ orgId: 'org-1', month: '2026-08', billableUsd: 15, listPriceUsd: 10 }],
			assumptions,
		}

		const [acme, beta] = customerMarginRows(inputs)
		// Revenue: 4500 build fee + 15 USD × 10 resident billed = 4650
		expect(acme).toMatchObject({
			id: 'org-1',
			buildFeeSek: 4500,
			residentRevenueSek: 150,
			buildCostSek: 100,
			residentCostSek: 100,
			revenueSek: 4650,
			costSek: 200,
			marginSek: 4450,
			marginPct: 96,
			subscriptionSekPerMonth: 600,
			infraSekPerMonth: 200,
			monthlyMarginSek: 400,
		})
		// No revenue at all: no margin %, no modeled subscription
		expect(beta).toMatchObject({
			id: 'org-2',
			revenueSek: 0,
			costSek: 0,
			subscriptionSekPerMonth: 0,
			infraSekPerMonth: 0,
		})
		expect(beta!.marginPct).toBeUndefined()
	})

	it('Does not model a subscription for a torn-down or undelivered order', () => {
		const base = {
			orgs: [{ id: 'org-1', name: 'Acme AB', createdAt: '2026-06-01T00:00:00Z' }],
			jobs: [],
			revenue: [],
			usage: [],
			assumptions,
		}
		const order = {
			id: 'o1',
			orgId: 'org-1',
			status: 'paid',
			priceSek: 500,
			createdAt: '2026-07-01T00:00:00Z',
		} as const

		const tornDown = customerMarginRows({
			...base,
			orders: [{ ...order, lifecycle: 'torn_down' }],
		})
		expect(tornDown[0]!.subscriptionSekPerMonth).toBe(0)

		const building = customerMarginRows({
			...base,
			orders: [{ ...order, status: 'building', lifecycle: 'active' }],
		})
		expect(building[0]!.subscriptionSekPerMonth).toBe(0)
	})

	it('Buckets the P&L per month from the first activity through the current month', () => {
		const inputs = {
			orgs: [{ id: 'org-1', name: 'Acme AB', createdAt: '2026-06-01T00:00:00Z' }],
			jobs: [
				{ id: 'a', orgId: 'org-1', costUsd: 10, createdAt: '2026-06-10T00:00:00Z' },
				{ id: 'b', orgId: 'org-1', costUsd: 5, createdAt: '2026-08-01T00:00:00Z' },
			],
			orders: [
				{
					id: 'o1',
					orgId: 'org-1',
					status: 'delivered' as const,
					priceSek: 3000,
					lifecycle: 'active' as const,
					frozenAt: '2026-06-12T00:00:00Z',
					createdAt: '2026-06-01T00:00:00Z',
				},
				// Cancelled: never counted as revenue
				{
					id: 'o2',
					orgId: 'org-1',
					status: 'cancelled' as const,
					priceSek: 9999,
					lifecycle: 'active' as const,
					createdAt: '2026-06-01T00:00:00Z',
				},
			],
			revenue: [],
			usage: [{ orgId: 'org-1', month: '2026-07', billableUsd: 15, listPriceUsd: 10 }],
			assumptions,
			infraTotalMonthlyUsd: 130,
			now,
		}

		const pnl = monthlyPnl(inputs)
		expect(pnl.map(row => row.id)).toEqual(['2026-06', '2026-07', '2026-08'])

		const [june, july, august] = pnl
		// June: build fee recognized at the frozen month + first subscription month; infra always on
		expect(june).toMatchObject({
			buildFeeSek: 3000,
			subscriptionSek: 600,
			buildCostSek: 100,
			infraSek: 1300,
			revenueSek: 3600,
			costSek: 1400,
			marginSek: 2200,
		})
		// July: the subscription keeps running; resident usage billed ×1.5 over our list cost
		expect(july).toMatchObject({
			buildFeeSek: 0,
			subscriptionSek: 600,
			residentRevenueSek: 150,
			residentCostSek: 100,
			buildCostSek: 0,
		})
		expect(august).toMatchObject({ buildFeeSek: 0, subscriptionSek: 600, buildCostSek: 50 })
	})

	it('Returns an empty P&L when nothing has happened yet', () => {
		expect(
			monthlyPnl({
				orgs: [],
				jobs: [],
				orders: [],
				revenue: [],
				usage: [],
				assumptions,
				infraTotalMonthlyUsd: 130,
				now,
			})
		).toEqual([])
	})

	it('Ships default assumptions matching the decided revenue model (2026-08-31)', () => {
		expect(defaultAssumptions.subscriptionSekPerMonth).toBe(600)
		expect(defaultAssumptions.tokenMarkup).toBe(1.5)
		expect(defaultAssumptions.awsPassthroughMarkup).toBe(1.2)
	})
})

describe('Mock margin customers', () => {
	const data = mockMarginData(now)

	it('Produces revenue rows in the api response shape', () => {
		expect(CustomerRevenueListResponseSchema.parse(data.revenue)).toHaveLength(4)
	})

	it('Tells one consistent story across revenue, orders and usage', () => {
		for (const row of data.revenue) {
			const paidOrders = data.orders.filter(
				order => order.orgId === row.orgId && order.status !== 'drafting'
			)
			expect(row.buildFeeSek, row.orgId).toBe(
				paidOrders.reduce((sum, order) => sum + (order.priceSek ?? 0), 0)
			)
			const billable = data.usage
				.filter(usage => usage.orgId === row.orgId)
				.reduce((sum, usage) => sum + usage.billableUsd, 0)
			expect(row.residentBillableUsd, row.orgId).toBeCloseTo(billable, 2)
		}
	})

	it('Keeps every margin view populated: subscribed, unconverted and zero rows all present', () => {
		const rows = customerMarginRows({ ...data, assumptions })
		expect(rows).toHaveLength(4)
		expect(rows.filter(row => row.subscriptionSekPerMonth > 0)).toHaveLength(2)
		expect(rows.filter(row => row.revenueSek === 0)).toHaveLength(1)

		const pnl = monthlyPnl({ ...data, assumptions, infraTotalMonthlyUsd: data.infra.totalMonthlyCostUsd, now })
		expect(pnl).toHaveLength(5)
		expect(pnl.at(-1)!.id).toBe('2026-08')
	})
})

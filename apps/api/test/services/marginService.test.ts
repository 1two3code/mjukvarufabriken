import { sharedInfraMonthlyCostUsd } from '@mf/models'

import { createMockResidentUsageRecord } from '#/services/__mocks__/residentService.ts'

import type { FastifyInstance } from 'fastify'

const totalMonthlyCostUsd = Object.values(sharedInfraMonthlyCostUsd).reduce((a, b) => a + b, 0)

describe('Margin Service', () => {
	let app: FastifyInstance

	beforeEach(async () => {
		app = await createTestApp({ skipMock: '#/services/marginService.ts' })
	})

	describe('infraCostAllocation', () => {
		it('Splits the shared cost evenly across orgs with an active, non-cancelled order', async () => {
			// Arrange — active: counted; cancelled: excluded; suspended: excluded
			const active = await app.db.users.insertOrg({ name: 'Active AB' })
			await app.db.orders.insert({ id: 'order-active', orgId: active.id, name: 'x' })

			const cancelled = await app.db.users.insertOrg({ name: 'Cancelled AB' })
			await app.db.orders.insert({ id: 'order-cancelled', orgId: cancelled.id, name: 'x' })
			await app.db.orders.transition('order-cancelled', ['drafting'], 'cancelled')

			const suspended = await app.db.users.insertOrg({ name: 'Suspended AB' })
			await app.db.orders.insert({ id: 'order-suspended', orgId: suspended.id, name: 'x' })
			await app.db.orders.setLifecycle('order-suspended', ['active'], 'suspended')

			// Act
			const allocation = await app.marginService.infraCostAllocation()

			// Assert
			expect(allocation.activeOrgIds).toEqual([active.id])
			expect(allocation.totalMonthlyCostUsd).toBe(totalMonthlyCostUsd)
			expect(allocation.breakdown).toEqual(sharedInfraMonthlyCostUsd)
			expect(allocation.perOrgMonthlyCostUsd).toBe(totalMonthlyCostUsd)
		})

		it('Divides across every active org, and falls back to the total with none active', async () => {
			// Arrange
			const first = await app.db.users.insertOrg({ name: 'First AB' })
			await app.db.orders.insert({ id: 'order-1', orgId: first.id, name: 'x' })
			const second = await app.db.users.insertOrg({ name: 'Second AB' })
			await app.db.orders.insert({ id: 'order-2', orgId: second.id, name: 'x' })

			// Act
			const withTwoActive = await app.marginService.infraCostAllocation()

			// Assert
			expect(withTwoActive.activeOrgIds.sort()).toEqual([first.id, second.id].sort())
			expect(withTwoActive.perOrgMonthlyCostUsd).toBe(
				Math.round((totalMonthlyCostUsd / 2) * 100) / 100
			)

			// Arrange — no orgs at all
			const emptyApp = await createTestApp({ skipMock: '#/services/marginService.ts' })
			const withNoneActive = await emptyApp.marginService.infraCostAllocation()
			expect(withNoneActive.activeOrgIds).toEqual([])
			expect(withNoneActive.perOrgMonthlyCostUsd).toBe(totalMonthlyCostUsd)
		})
	})

	describe('revenueByCustomer', () => {
		it('Aggregates paid payments and resident billable usage per org, zero for untracked flows', async () => {
			// Arrange — org-1: a delivered order with a paid deposit + balance, and resident usage
			const withRevenue = await app.db.users.insertOrg({ name: 'Acme AB' })
			await app.db.orders.insert({ id: 'order-1', orgId: withRevenue.id, name: 'Gym booking' })
			const deposit = await app.db.orders.insertPayment({
				orderId: 'order-1',
				kind: 'deposit',
				provider: 'fake',
				amountSek: 7_500,
				vatSek: 1_875,
				totalSek: 9_375,
				sessionId: 'fake_1',
			})
			await app.db.orders.markPaymentPaid(deposit.id, {})
			const balance = await app.db.orders.insertPayment({
				orderId: 'order-1',
				kind: 'balance',
				provider: 'fake',
				amountSek: 7_500,
				vatSek: 1_875,
				totalSek: 9_375,
				sessionId: 'fake_2',
			})
			await app.db.orders.markPaymentPaid(balance.id, {})
			await app.db.resident.upsertInstallation({ id: 'acme-shop', orgId: withRevenue.id })
			await app.db.resident.upsertUsage(createMockResidentUsageRecord({ installationId: 'acme-shop' }))

			// Arrange — org-2: nothing paid yet, a pending deposit only
			const withoutRevenue = await app.db.users.insertOrg({ name: 'Beta AB' })
			await app.db.orders.insert({ id: 'order-2', orgId: withoutRevenue.id, name: 'CRM' })
			await app.db.orders.insertPayment({
				orderId: 'order-2',
				kind: 'deposit',
				provider: 'fake',
				amountSek: 5_000,
				vatSek: 1_250,
				totalSek: 6_250,
				sessionId: 'fake_3',
			})

			// Act
			const revenue = await app.marginService.revenueByCustomer()

			// Assert
			expect(revenue).toEqual(
				expect.arrayContaining([
					{
						orgId: withRevenue.id,
						orgName: 'Acme AB',
						buildFeeSek: 15_000,
						hostingSek: 0,
						slaSek: 0,
						furtherDevSek: 0,
						residentBillableUsd: 6.75,
					},
					{
						orgId: withoutRevenue.id,
						orgName: 'Beta AB',
						buildFeeSek: 0,
						hostingSek: 0,
						slaSek: 0,
						furtherDevSek: 0,
						residentBillableUsd: 0,
					},
				])
			)
		})
	})
})

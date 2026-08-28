import { runLifecycleSweep } from '#/lib/lifecycleSweep.ts'

import type { FastifyInstance } from 'fastify'

describe('Lifecycle grace-period sweep', () => {
	let app: FastifyInstance

	beforeEach(async () => {
		// Real accountService + db; the @mf/org seam stays mocked (no AWS in the loop).
		app = await createTestApp({ skipMock: '#/services/accountService.ts' })
		app.secrets.orgLifecycle.graceDays = 30
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	const seedSuspended = async (id: string) => {
		const org = await app.db.users.insertOrg({ name: `Org ${id}` })
		const order = await app.db.orders.insert({ id, orgId: org.id, name: `App ${id}` })
		await app.db.orders.setCustomerSlug(order.id, `app-${id}`)
		await app.accountService.runLifecycleAction(order.id, 'suspend', { confirm: true })
		return order
	}

	it('Leaves a still-in-grace suspended order untouched', async () => {
		const order = await seedSuspended('order-fresh')

		const result = await runLifecycleSweep(app)

		expect(result).toEqual({ checked: 0, tornDown: 0, failed: 0 })
		expect((await app.db.orders.getOrder(order.id))?.lifecycle).toBe('suspended')
	})

	it('Promotes a suspended order to torn_down once past the grace window, deprovisioning it', async () => {
		const order = await seedSuspended('order-old')
		vi.mocked(app.org.deprovision).mockClear()
		// Jump 31 days forward — past the 30-day grace window
		vi.useFakeTimers()
		vi.setSystemTime(Date.now() + 31 * 24 * 60 * 60 * 1000)

		const result = await runLifecycleSweep(app)

		expect(result).toEqual({ checked: 1, tornDown: 1, failed: 0 })
		expect((await app.db.orders.getOrder(order.id))?.lifecycle).toBe('torn_down')
		// A real (confirmed) teardown, fenced to the order's Customer=<slug>
		expect(app.org.deprovision).toHaveBeenCalledWith(
			expect.objectContaining({ customerSlug: 'app-order-old' }),
			'teardown',
			{ dryRun: false }
		)
	})

	it('Is idempotent — a torn-down order leaves the suspended set', async () => {
		await seedSuspended('order-twice')
		vi.useFakeTimers()
		vi.setSystemTime(Date.now() + 31 * 24 * 60 * 60 * 1000)

		await runLifecycleSweep(app)
		const second = await runLifecycleSweep(app)

		expect(second).toEqual({ checked: 0, tornDown: 0, failed: 0 })
	})

	it('Leaves an order suspended when its teardown deprovision reports resource failures', async () => {
		const order = await seedSuspended('order-fail')
		vi.useFakeTimers()
		vi.setSystemTime(Date.now() + 31 * 24 * 60 * 60 * 1000)
		// @mf/org records outcome:failed and returns (it never throws) — the sweep must NOT tear down.
		vi.mocked(app.org.deprovision).mockResolvedValueOnce({
			mode: 'teardown',
			dryRun: false,
			customerSlug: 'app-order-fail',
			discovered: 1,
			fenced: 1,
			skippedByFence: 0,
			entries: [],
			summary: {
				planned: 0,
				suspended: 0,
				resumed: 0,
				deleted: 0,
				skipped: 0,
				'already-gone': 0,
				failed: 1,
			},
		})

		const result = await runLifecycleSweep(app)

		expect(result).toEqual({ checked: 1, tornDown: 0, failed: 1 })
		// Still suspended, so the next hourly pass retries it.
		expect((await app.db.orders.getOrder(order.id))?.lifecycle).toBe('suspended')
	})

	it('Continues past an order whose teardown throws (fault-tolerant)', async () => {
		await seedSuspended('order-a')
		await seedSuspended('order-b')
		vi.useFakeTimers()
		vi.setSystemTime(Date.now() + 31 * 24 * 60 * 60 * 1000)
		// The first teardown attempt blows up; the sweep must still reach the second order
		vi.spyOn(app.accountService, 'runLifecycleAction').mockRejectedValueOnce(new Error('boom'))

		const result = await runLifecycleSweep(app)

		expect(result.checked).toBe(2)
		expect(result.tornDown).toBe(1)
	})
})

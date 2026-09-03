import { runLifecycleSweep } from '#/lib/lifecycleSweep.ts'

import type { FastifyInstance } from 'fastify'

describe('Lifecycle grace-period sweep', () => {
	let app: FastifyInstance

	beforeEach(async () => {
		// Real accountService + exportService + db; the @mf/org seam stays mocked (no AWS in the loop).
		app = await createTestApp({
			skipMock: ['#/services/accountService.ts', '#/services/exportService.ts'],
		})
		app.secrets.orgLifecycle.graceDays = 30
		// The sweep only tears down with the lifecycle flag on (a teardown is refused without it)
		app.secrets.orgLifecycle.enabled = true
		// No delivered job in the mocked jobs → the export holds nothing, which is a valid `done`
		vi.spyOn(app.db.jobs, 'list').mockResolvedValue([])
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

		expect(result).toEqual({ checked: 0, tornDown: 0, failed: 0, skipped: 0 })
		expect((await app.db.orders.getOrder(order.id))?.lifecycle).toBe('suspended')
	})

	it('Promotes a suspended order to torn_down once past the grace window, deprovisioning it', async () => {
		const order = await seedSuspended('order-old')
		vi.mocked(app.org.deprovision).mockClear()
		// Jump 31 days forward — past the 30-day grace window
		vi.useFakeTimers()
		vi.setSystemTime(Date.now() + 31 * 24 * 60 * 60 * 1000)

		const result = await runLifecycleSweep(app)

		expect(result).toEqual({ checked: 1, tornDown: 1, failed: 0, skipped: 0 })
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

		expect(second).toEqual({ checked: 0, tornDown: 0, failed: 0, skipped: 0 })
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

		expect(result).toEqual({ checked: 1, tornDown: 0, failed: 1, skipped: 0 })
		// Still suspended, so the next hourly pass retries it.
		expect((await app.db.orders.getOrder(order.id))?.lifecycle).toBe('suspended')
	})

	it('Takes the final export first and postpones a teardown whose export is not done (wave 14)', async () => {
		const order = await seedSuspended('order-export')
		vi.useFakeTimers()
		vi.setSystemTime(Date.now() + 31 * 24 * 60 * 60 * 1000)
		const exportSpy = vi.spyOn(app.exportService, 'finalExport').mockResolvedValueOnce({
			orderId: order.id,
			key: 'deliverables/order-export/export/',
			status: 'failed',
			error: 'S3 down',
			files: [],
			createdAt: new Date().toISOString(),
		})
		const teardownSpy = vi.spyOn(app.accountService, 'runLifecycleAction')

		const postponed = await runLifecycleSweep(app)

		expect(postponed).toEqual({ checked: 1, tornDown: 0, failed: 1, skipped: 0 })
		expect(teardownSpy).not.toHaveBeenCalled()
		expect((await app.db.orders.getOrder(order.id))?.lifecycle).toBe('suspended')

		// Next pass: the real export succeeds and the teardown follows it
		const retried = await runLifecycleSweep(app)

		expect(retried).toEqual({ checked: 1, tornDown: 1, failed: 0, skipped: 0 })
		expect(exportSpy.mock.invocationCallOrder.at(-1)).toBeLessThan(
			teardownSpy.mock.invocationCallOrder[0]!
		)
		expect((await app.db.orders.getOrder(order.id))?.lifecycle).toBe('torn_down')
	})

	it('Skips every due order while ORG_LIFECYCLE_ENABLED is off — no export, no state change', async () => {
		const order = await seedSuspended('order-dark')
		app.secrets.orgLifecycle.enabled = false
		vi.useFakeTimers()
		vi.setSystemTime(Date.now() + 31 * 24 * 60 * 60 * 1000)
		const exportSpy = vi.spyOn(app.exportService, 'finalExport')

		const result = await runLifecycleSweep(app)

		expect(result).toEqual({ checked: 1, tornDown: 0, failed: 0, skipped: 1 })
		expect(exportSpy).not.toHaveBeenCalled()
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

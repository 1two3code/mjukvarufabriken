import { hostingSweepLabel, runHostingSweep } from '#/lib/hostingSweep.ts'
import { createMockOrderExport } from '#/services/__mocks__/exportService.ts'

import type { FastifyInstance } from 'fastify'

const dayMs = 24 * 60 * 60 * 1000

describe('Hosting-window sweep', () => {
	let app: FastifyInstance

	beforeEach(async () => {
		// Real accountService + exportService over the in-memory db; @mf/org, s3 and the preview
		// services stay mocked (no AWS in the loop).
		app = await createTestApp({
			skipMock: ['#/services/accountService.ts', '#/services/exportService.ts'],
		})
		// No delivered job in the mocked jobs → the export holds nothing, which is a valid `done`
		vi.spyOn(app.db.jobs, 'list').mockResolvedValue([])
	})

	const seedOrder = async (id: string, hostingUntil: Date | undefined) => {
		const org = await app.db.users.insertOrg({ name: `Org ${id}` })
		const order = await app.db.orders.insert({ id, orgId: org.id, name: `App ${id}` })
		await app.db.orders.setCustomerSlug(order.id, `app-${id}`)
		if (hostingUntil) await app.db.orders.setHostingUntil(order.id, hostingUntil)
		return order
	}

	it('Leaves orders whose window is still open (or has no end) untouched', async () => {
		await seedOrder('order-open', new Date(Date.now() + dayMs))
		await seedOrder('order-forever', undefined)

		const result = await runHostingSweep(app)

		expect(result).toEqual({ checked: 0, exported: 0, tornDown: 0, failed: 0 })
		expect(app.org.deprovision).not.toHaveBeenCalled()
	})

	it('Exports FIRST, then tears down an order whose window ended', async () => {
		const order = await seedOrder('order-ended', new Date(Date.now() - dayMs))
		const exportSpy = vi.spyOn(app.exportService, 'finalExport')
		const teardownSpy = vi.spyOn(app.accountService, 'runLifecycleAction')

		const result = await runHostingSweep(app)

		expect(result).toEqual({ checked: 1, exported: 1, tornDown: 1, failed: 0 })
		expect((await app.db.orders.getOrder(order.id))?.lifecycle).toBe('torn_down')
		expect((await app.db.orderExports.get(order.id))?.status).toBe('done')
		// Ordering: the export claim precedes the teardown call
		expect(exportSpy.mock.invocationCallOrder[0]).toBeLessThan(
			teardownSpy.mock.invocationCallOrder[0]!
		)
		expect(teardownSpy).toHaveBeenCalledWith(order.id, 'teardown', {
			confirm: true,
			label: hostingSweepLabel,
		})
		// A real (confirmed) teardown, fenced to the order's Customer=<slug>
		expect(app.org.deprovision).toHaveBeenCalledWith(
			expect.objectContaining({ customerSlug: 'app-order-ended', label: hostingSweepLabel }),
			'teardown',
			{ dryRun: false }
		)
	})

	it('Postpones the teardown and mails the admins when the export is not done', async () => {
		const order = await seedOrder('order-stuck', new Date(Date.now() - dayMs))
		vi.spyOn(app.exportService, 'finalExport').mockResolvedValue(
			createMockOrderExport({ orderId: order.id, status: 'failed', error: 'S3 down' })
		)
		const teardownSpy = vi.spyOn(app.accountService, 'runLifecycleAction')

		const result = await runHostingSweep(app)

		expect(result).toEqual({ checked: 1, exported: 0, tornDown: 0, failed: 1 })
		expect(teardownSpy).not.toHaveBeenCalled()
		expect((await app.db.orders.getOrder(order.id))?.lifecycle).toBe('active')
		expect(app.email.send).toHaveBeenCalledWith(
			expect.objectContaining({
				to: 'admin@example.com',
				subject: expect.stringContaining(order.id),
				text: expect.stringContaining('S3 down'),
			})
		)
	})

	it('Is idempotent — a torn-down order leaves the active set', async () => {
		await seedOrder('order-twice', new Date(Date.now() - dayMs))

		await runHostingSweep(app)
		const second = await runHostingSweep(app)

		expect(second).toEqual({ checked: 0, exported: 0, tornDown: 0, failed: 0 })
	})

	it('Continues past an order whose teardown throws (fault-tolerant)', async () => {
		await seedOrder('order-a', new Date(Date.now() - 2 * dayMs))
		await seedOrder('order-b', new Date(Date.now() - dayMs))
		vi.spyOn(app.accountService, 'runLifecycleAction').mockRejectedValueOnce(new Error('boom'))

		const result = await runHostingSweep(app)

		expect(result.checked).toBe(2)
		expect(result.tornDown).toBe(1)
		expect(result.failed).toBe(1)
	})
})

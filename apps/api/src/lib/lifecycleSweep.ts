import type { FastifyInstance } from 'fastify'

/** Milliseconds in a day — the grace window is configured in whole days. */
const dayMs = 24 * 60 * 60 * 1000

/** The grace window in ms, from the configured day count. */
export const graceWindowMs = (graceDays: number) => graceDays * dayMs

/**
 * One grace-period pass (teardown-deprovisioning.md #4): every order that has sat `suspended`
 * longer than the configured grace window is promoted to `torn_down`, deprovisioning its tagged
 * AWS resources (fenced to the order's `Customer=<slug>`) via the same admin lifecycle action.
 *
 * Reuses the M9 liveness-sweep machinery (the shared `scheduleHousekeeping` scheduler that drives
 * this): Postgres-only, run shortly after boot and hourly, idempotent (a torn-down order leaves the
 * `suspended` set, so a later pass skips it), and fault-tolerant — a single order's teardown that
 * throws is logged and the sweep continues. Returns the counts for logs and tests.
 *
 * Since wave 14 every teardown is preceded by the order's final export (`exportService`): the
 * teardown is refused until it is `done`, so the sweep takes it first and leaves an order whose
 * export failed `suspended` for the next pass (the hosting sweep does the same for `active`).
 */
export const runLifecycleSweep = async (
	app: FastifyInstance
): Promise<{ checked: number; tornDown: number; failed: number }> => {
	const changedBefore = new Date(Date.now() - graceWindowMs(app.secrets.orgLifecycle.graceDays))
	const due = await app.db.orders.listSuspendedBefore(changedBefore)
	if (!due.length) return { checked: 0, tornDown: 0, failed: 0 }

	let tornDown = 0
	let failed = 0
	for (const order of due) {
		try {
			const exported = await app.exportService.finalExport(order.id)
			if (exported.status !== 'done') {
				failed++
				app.log.warn(
					{ orderId: order.id, status: exported.status, error: exported.error },
					'Grace-period export not done — teardown postponed to the next pass'
				)
				continue
			}
			const result = await app.accountService.runLifecycleAction(order.id, 'teardown', {
				confirm: true,
				label: 'grace-period sweep',
			})
			if (result.applied) {
				tornDown++
			} else if (result.deprovision && result.deprovision.summary.failed > 0) {
				// runLifecycleAction inspected the deprovision tally and kept the order `suspended`
				// because a resource action reported `failed` (@mf/org records it rather than throwing).
				// Surface it; the order stays in the `suspended` set, so the next hourly pass retries.
				failed++
				app.log.warn(
					{ orderId: order.id, failed: result.deprovision.summary.failed },
					'Grace-period teardown left order suspended — deprovision reported resource failures'
				)
			}
		} catch (error) {
			failed++
			app.log.warn({ err: error, orderId: order.id }, 'Grace-period teardown failed')
		}
	}

	const result = { checked: due.length, tornDown, failed }
	if (tornDown || failed) app.log.info(result, 'Grace-period sweep ran over suspended orders')
	return result
}

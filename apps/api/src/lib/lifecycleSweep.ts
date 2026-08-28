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
 */
export const runLifecycleSweep = async (
	app: FastifyInstance
): Promise<{ checked: number; tornDown: number }> => {
	const changedBefore = new Date(Date.now() - graceWindowMs(app.secrets.orgLifecycle.graceDays))
	const due = await app.db.orders.listSuspendedBefore(changedBefore)
	if (!due.length) return { checked: 0, tornDown: 0 }

	let tornDown = 0
	for (const order of due) {
		try {
			const result = await app.accountService.runLifecycleAction(order.id, 'teardown', {
				confirm: true,
				label: 'grace-period sweep',
			})
			if (result.applied) tornDown++
		} catch (error) {
			app.log.warn({ err: error, orderId: order.id }, 'Grace-period teardown failed')
		}
	}

	const result = { checked: due.length, tornDown }
	if (tornDown) app.log.info(result, 'Grace-period sweep tore down suspended orders')
	return result
}

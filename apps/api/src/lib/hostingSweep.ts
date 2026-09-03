import type { FastifyInstance } from 'fastify'
import type { Order } from '@mf/models'

/** What every scheduled teardown is labelled with (in the log, the certificate, the deprovision audit) */
export const hostingSweepLabel = 'hosting window ended'

/**
 * Mails the admins about an order the sweep could not export — the order is left `active` for the
 * next pass, so a human must hear about it or it retries silently forever. Guarded: the sweep also
 * runs in tests without the email plugin.
 */
const notifyExportFailure = async (app: FastifyInstance, order: Order, reason: string) => {
	const { email, secrets } = app as Partial<FastifyInstance>
	if (!email || !secrets) return
	const subject = `[mf ${secrets.env}] Hosting-window export failed for order ${order.id}`
	const text = `The hosting window of order ${order.id} (${order.name}) ended at ${order.hostingUntil}, but its final export did not complete, so the scheduled teardown was NOT run.\n\nReason:\n${reason}\n\nThe hourly sweep retries; fix the cause or clear the order's hosting window in the portal.`
	for (const to of secrets.authAdminEmails) {
		await email.send({ to, subject, text }).catch((error: Error) => {
			app.log.error({ err: error, orderId: order.id, to }, 'Could not send the export failure mail')
		})
	}
}

/** What one hosting-window pass did, for logs and tests */
export type HostingSweepResult = {
	checked: number
	exported: number
	tornDown: number
	failed: number
	/** Due orders left alone because `ORG_LIFECYCLE_ENABLED` is off (nothing could be torn down) */
	skipped: number
}

/**
 * One hosting-window pass (wave 14, strategy F4): every order still `active` whose included
 * hosting window has ended gets its final export taken and is then torn down — export FIRST,
 * teardown only after the export is `done`. A failed or in-flight export leaves the order
 * untouched for the next pass (logged + admins mailed); a teardown whose deprovision reports
 * resource failures leaves it `active` the same way. Shares the grace sweep's machinery:
 * Postgres-only hourly schedule, idempotent (a torn-down order leaves the `active` set, a fresh
 * `done` export is not retaken), fault-tolerant per order. Returns the counts for logs and tests.
 *
 * While `ORG_LIFECYCLE_ENABLED` is off the pass only counts the due orders as `skipped`: with the
 * flag off a teardown is refused (`LifecycleDisabled`) because nothing would actually be deleted,
 * so exporting and mailing every hour would be noise about a teardown that cannot happen. The
 * orders stay `active` with their ended window and are picked up once the flag is on.
 */
export const runHostingSweep = async (app: FastifyInstance): Promise<HostingSweepResult> => {
	const due = await app.db.orders.listActiveWithHostingUntilBefore(new Date())
	if (!due.length) return { checked: 0, exported: 0, tornDown: 0, failed: 0, skipped: 0 }
	if (!app.secrets.orgLifecycle.enabled) {
		app.log.info(
			{ orderIds: due.map(order => order.id) },
			'Hosting-window sweep skipped ended orders — ORG_LIFECYCLE_ENABLED is off'
		)
		return { checked: due.length, exported: 0, tornDown: 0, failed: 0, skipped: due.length }
	}

	let exported = 0
	let tornDown = 0
	let failed = 0
	for (const order of due) {
		try {
			const result = await app.exportService.finalExport(order.id)
			if (result.status !== 'done') {
				failed++
				const reason = result.error ?? `export is ${result.status}`
				app.log.warn(
					{ orderId: order.id, status: result.status, error: result.error },
					'Hosting-window export not done — teardown postponed to the next pass'
				)
				await notifyExportFailure(app, order, reason)
				continue
			}
			exported++
			const teardown = await app.accountService.runLifecycleAction(order.id, 'teardown', {
				confirm: true,
				label: hostingSweepLabel,
			})
			if (teardown.applied) {
				tornDown++
			} else if (teardown.deprovision && teardown.deprovision.summary.failed > 0) {
				failed++
				app.log.warn(
					{ orderId: order.id, failed: teardown.deprovision.summary.failed },
					'Hosting-window teardown left order active — deprovision reported resource failures'
				)
			}
		} catch (error) {
			failed++
			app.log.warn({ err: error, orderId: order.id }, 'Hosting-window teardown failed')
		}
	}

	const result = { checked: due.length, exported, tornDown, failed, skipped: 0 }
	app.log.info(result, 'Hosting-window sweep ran over ended orders')
	return result
}

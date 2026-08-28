import fp from 'fastify-plugin'

import { scheduleHousekeeping } from '#/lib/housekeeping.ts'
import { runLifecycleSweep } from '#/lib/lifecycleSweep.ts'

import type { FastifyPluginAsync } from 'fastify'

/**
 * Grace-period sweep (teardown-deprovisioning.md #4): an order suspended longer than the
 * configured grace window is promoted to `torn_down` and its tagged AWS resources deprovisioned.
 * Reuses the M9 liveness-sweep machinery — the shared `scheduleHousekeeping` schedule (Postgres
 * only, shortly after boot then hourly, jittered, cleared on close).
 */
const plugin: FastifyPluginAsync = async app => {
	scheduleHousekeeping(app, 'Lifecycle grace-period sweep', async () => {
		await runLifecycleSweep(app)
	})
}

export default fp(plugin, {
	name: '#internal/lifecycleSweeper',
	dependencies: ['#internal/db', '#internal/accountService'],
})

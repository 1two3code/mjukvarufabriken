import fp from 'fastify-plugin'

import { runHostingSweep } from '#/lib/hostingSweep.ts'
import { scheduleHousekeeping } from '#/lib/housekeeping.ts'

import type { FastifyPluginAsync } from 'fastify'

/**
 * Hosting-window sweep (wave 14, strategy F4): an order whose included hosting window has ended
 * gets its final export taken and is then torn down. Same schedule as the grace-period sweep
 * (`scheduleHousekeeping`: Postgres only, shortly after boot then hourly, jittered, cleared on
 * close) — a separate plugin so the two sweeps log and fail independently.
 */
const plugin: FastifyPluginAsync = async app => {
	scheduleHousekeeping(app, 'Hosting-window sweep', async () => {
		await runHostingSweep(app)
	})
}

export default fp(plugin, {
	name: '#internal/hostingSweeper',
	dependencies: ['#internal/db', '#internal/accountService', '#internal/exportService'],
})

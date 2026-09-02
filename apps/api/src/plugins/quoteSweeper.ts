import fp from 'fastify-plugin'

import { scheduleHousekeeping } from '#/lib/housekeeping.ts'

import type { FastifyPluginAsync } from 'fastify'

/**
 * Anonymous-quote retention sweep (wave 14, F1 — GDPR): unclaimed anonymous orders older than
 * `anonymousQuoteRetentionDays` are deleted. Same schedule as the grace-period sweep — the shared
 * `scheduleHousekeeping` (Postgres only, shortly after boot then hourly, jittered, cleared on close).
 */
const plugin: FastifyPluginAsync = async app => {
	scheduleHousekeeping(app, 'Anonymous quote sweep', async () => {
		await app.quoteService.sweepUnclaimed()
	})
}

export default fp(plugin, {
	name: '#internal/quoteSweeper',
	dependencies: ['#internal/db', '#internal/quoteService'],
})

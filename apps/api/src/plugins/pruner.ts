import fp from 'fastify-plugin'

import { scheduleHousekeeping } from '#/lib/housekeeping.ts'

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'

/**
 * Deletes the rows every request leaves behind and nothing else removes: expired magic links,
 * revoked/expired refresh tokens and rate-limit hits older than any window. Runs each repository's
 * own `pruneExpired()` and logs one summary line. Returns the per-repository counts (for tests).
 */
export const runPrune = async (
	app: FastifyInstance
): Promise<{ auth: number; rateLimits: number }> => {
	const [auth, rateLimits] = await Promise.all([
		app.db.auth.pruneExpired(),
		app.db.rateLimits.pruneExpired(),
	])
	app.log.info({ auth, rateLimits }, 'Pruned expired rows')
	return { auth, rateLimits }
}

/**
 * Background pruner: shortly after boot and then hourly (with jitter), it prunes the expired auth
 * and rate-limit rows. Postgres only and cleared on close — the memory repositories sweep
 * themselves on insert and are gone on restart, so `scheduleHousekeeping` no-ops there.
 */
const plugin: FastifyPluginAsync = async app => {
	scheduleHousekeeping(app, 'Prune', async () => {
		await runPrune(app)
	})
}

export default fp(plugin, { name: '#internal/pruner', dependencies: ['#internal/db'] })

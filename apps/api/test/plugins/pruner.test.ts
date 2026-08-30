import { runPrune } from '#/plugins/pruner.ts'

import type { FastifyInstance } from 'fastify'
import type * as housekeeping from '#/lib/housekeeping.ts'

// The scheduler is unit-tested in test/lib/housekeeping.test.ts; here only its wiring matters
vi.mock('#/lib/housekeeping.ts', async importOriginal => ({
	...(await importOriginal<typeof housekeeping>()),
	scheduleHousekeeping: vi.fn(),
}))

describe('pruner plugin', () => {
	it('Schedules an hourly prune through the shared scheduler', async () => {
		// Arrange
		const { scheduleHousekeeping } = await import('#/lib/housekeeping.ts')

		// Act
		await createTestApp()

		// Assert
		const call = vi.mocked(scheduleHousekeeping).mock.calls.findLast(([, name]) => name === 'Prune')
		expect(call).toBeDefined()
	})

	describe('runPrune', () => {
		/** A fake app exposing only what `runPrune` touches: the two repositories and the logger */
		const createApp = (auth: number, rateLimits: number) => {
			const db = {
				auth: { pruneExpired: vi.fn().mockResolvedValue(auth) },
				rateLimits: { pruneExpired: vi.fn().mockResolvedValue(rateLimits) },
			}
			const log = { info: vi.fn() }
			return { app: { db, log } as unknown as FastifyInstance, db, log }
		}

		it('Prunes every repository and returns the per-repository counts', async () => {
			// Arrange
			const { app, db } = createApp(3, 5)

			// Act
			const result = await runPrune(app)

			// Assert
			expect(db.auth.pruneExpired).toHaveBeenCalledTimes(1)
			expect(db.rateLimits.pruneExpired).toHaveBeenCalledTimes(1)
			expect(result).toEqual({ auth: 3, rateLimits: 5 })
		})

		it('Logs a one-line summary of what it dropped', async () => {
			// Arrange
			const { app, log } = createApp(2, 0)

			// Act
			await runPrune(app)

			// Assert
			expect(log.info).toHaveBeenCalledWith({ auth: 2, rateLimits: 0 }, 'Pruned expired rows')
		})
	})
})

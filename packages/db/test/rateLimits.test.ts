import { memoryRateLimitRetentionMs } from '#/memory.ts'
import { rateLimitRetentionMs, rateLimitWindowStart } from '#/rateLimits.ts'

describe('rate-limit retention invariant', () => {
	it('Shares one retention literal between the Postgres pruner and the memory sweep', () => {
		// Single source of truth: the two constants cannot drift because one aliases the other.
		expect(memoryRateLimitRetentionMs).toBe(rateLimitRetentionMs)
	})

	describe('rateLimitWindowStart', () => {
		const now = new Date('2026-08-26T10:00:00.000Z')

		it('Returns now - windowMs for a window inside the retention', () => {
			const since = rateLimitWindowStart(10 * 60 * 1000, now)
			expect(since.getTime()).toBe(now.getTime() - 10 * 60 * 1000)
		})

		it('Allows a window exactly equal to the retention (boundary)', () => {
			const since = rateLimitWindowStart(rateLimitRetentionMs, now)
			expect(since.getTime()).toBe(now.getTime() - rateLimitRetentionMs)
		})

		it('Throws when the window would outlast the retention, so pruned hits cannot bypass a limit', () => {
			expect(() => rateLimitWindowStart(rateLimitRetentionMs + 1, now)).toThrow(/exceeds retention/)
		})

		it('Defaults to the current time when no now is given', () => {
			const before = Date.now()
			const since = rateLimitWindowStart(60 * 1000)
			const after = Date.now()
			expect(since.getTime()).toBeGreaterThanOrEqual(before - 60 * 1000)
			expect(since.getTime()).toBeLessThanOrEqual(after - 60 * 1000)
		})
	})
})

import { BudgetTracker } from '#job/budget.ts'

describe('BudgetTracker', () => {
	const budget = { maxTokens: 1000, maxDurationMinutes: 10, maxWorkers: 2 }

	it('Sums usage (cache reads at 10 %) and aborts once the cap is crossed', () => {
		const tracker = new BudgetTracker(budget)
		tracker.add({ inputTokens: 400, outputTokens: 100, cacheReadInputTokens: 200 })
		expect(tracker.used).toBe(520)
		expect(tracker.aborted).toBe(false)

		tracker.add({ inputTokens: 480, outputTokens: 1 })
		expect(tracker.used).toBe(1001)
		expect(tracker.aborted).toBe(true)
		expect(tracker.reason).toBe('budget exceeded')
		expect(tracker.signal.reason).toBeInstanceOf(Error)
	})

	it('Aborts on the wall clock and keeps the first reason', () => {
		let now = 0
		const tracker = new BudgetTracker(budget, () => now)
		tracker.checkDuration()
		expect(tracker.aborted).toBe(false)
		now = 11 * 60_000
		tracker.checkDuration()
		expect(tracker.reason).toBe('duration exceeded')
		tracker.abort('killed')
		expect(tracker.reason).toBe('duration exceeded')
	})

	it('adjust ignores non-positive deltas', () => {
		const tracker = new BudgetTracker(budget)
		tracker.adjust(-5)
		tracker.adjust(0)
		expect(tracker.used).toBe(0)
	})
})

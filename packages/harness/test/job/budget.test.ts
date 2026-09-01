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

	it('Proxy-observed usage lives on its own ledger — never double counted into used/usage', () => {
		const tracker = new BudgetTracker(budget)
		tracker.add({ inputTokens: 300, outputTokens: 100 }, 'claude-sonnet-5')
		// The proxy sees the SDK's own traffic again (superset) — observed overlaps, used does not grow
		tracker.addObserved({ inputTokens: 300, outputTokens: 100 })
		expect(tracker.used).toBe(400)
		expect(tracker.observed).toBe(400)
		expect(tracker.usage).toEqual({
			'claude-sonnet-5': {
				inputTokens: 300,
				outputTokens: 100,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
			},
		})
		expect(tracker.aborted).toBe(false)
	})

	it('Out-of-band spend observed at the proxy trips the same budget abort (cache reads at 10 %)', () => {
		const tracker = new BudgetTracker(budget)
		tracker.addObserved({ inputTokens: 400, outputTokens: 100, cacheReadInputTokens: 200 })
		expect(tracker.observed).toBe(520)
		expect(tracker.aborted).toBe(false)
		tracker.addObserved({ inputTokens: 481, outputTokens: 0 })
		expect(tracker.aborted).toBe(true)
		expect(tracker.reason).toBe('budget exceeded')
		// Enforcement only: the SDK-counted total and the billing basis are untouched
		expect(tracker.used).toBe(0)
		expect(tracker.usage).toEqual({})
	})

	it('adjust ignores non-positive deltas', () => {
		const tracker = new BudgetTracker(budget)
		tracker.adjust(-5)
		tracker.adjust(0)
		expect(tracker.used).toBe(0)
	})
})

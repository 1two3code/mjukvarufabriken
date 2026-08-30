import { createUsageAccumulator } from '#job/usage.ts'

describe('createUsageAccumulator', () => {
	it('Counts a turn once even when its usage arrives on several block messages', () => {
		const onUsage = vi.fn()
		const acc = createUsageAccumulator(onUsage)
		const usage = { inputTokens: 1000, outputTokens: 50, cacheReadInputTokens: 10_000 }

		expect(acc.add('msg_1', usage)).toBe(2050)
		expect(acc.add('msg_1', usage)).toBe(0)
		expect(acc.add('msg_1', usage)).toBe(0)
		expect(acc.total).toBe(2050)
		expect(onUsage).toHaveBeenCalledTimes(1)
	})

	it('Reports only the growth when a message id is seen again with more usage', () => {
		const acc = createUsageAccumulator(() => {})
		acc.add('msg_1', { inputTokens: 100, outputTokens: 10 })
		expect(acc.add('msg_1', { inputTokens: 100, outputTokens: 40 })).toBe(30)
		expect(acc.add('msg_2', { inputTokens: 5, outputTokens: 5 })).toBe(10)
		expect(acc.total).toBe(150)
	})

	it('Reconciles upwards only', () => {
		const onUsage = vi.fn()
		const acc = createUsageAccumulator(onUsage)
		acc.add('msg_1', { inputTokens: 100, outputTokens: 0 })
		expect(acc.reconcile(50)).toBe(0)
		expect(acc.reconcile(160)).toBe(60)
		expect(acc.total).toBe(160)
		expect(onUsage).toHaveBeenLastCalledWith({ inputTokens: 60, outputTokens: 0 })
	})

	it('Emits the raw four-bucket delta so cost/metering keep output and cache buckets', () => {
		const onUsage = vi.fn()
		const acc = createUsageAccumulator(onUsage)
		acc.add('msg_1', {
			inputTokens: 1000,
			outputTokens: 50,
			cacheReadInputTokens: 10_000,
			cacheCreationInputTokens: 200,
		})
		// Not a collapsed { inputTokens: <weighted> } scalar: every bucket is passed through raw
		expect(onUsage).toHaveBeenCalledWith({
			inputTokens: 1000,
			outputTokens: 50,
			cacheReadInputTokens: 10_000,
			cacheCreationInputTokens: 200,
		})
	})

	it('Emits only each bucket’s growth when a message id is seen again', () => {
		const onUsage = vi.fn()
		const acc = createUsageAccumulator(onUsage)
		acc.add('msg_1', { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 500 })
		acc.add('msg_1', { inputTokens: 100, outputTokens: 40, cacheReadInputTokens: 900 })
		expect(onUsage).toHaveBeenLastCalledWith({
			inputTokens: 0,
			outputTokens: 30,
			cacheReadInputTokens: 400,
			cacheCreationInputTokens: 0,
		})
	})

	it('Keeps the budget total weighted (cache reads at 10 %) while emitting raw buckets', () => {
		const onUsage = vi.fn()
		const acc = createUsageAccumulator(onUsage)
		// 200 input + 40 output + 5000 cache-read → 200 + 40 + 500 = 740 weighted
		acc.add('msg_1', { inputTokens: 200, outputTokens: 40, cacheReadInputTokens: 5000 })
		expect(acc.total).toBe(740)
	})
})

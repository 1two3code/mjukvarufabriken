import { cost, priceForModel, totalTokens } from '#job/types.ts'

describe('priceForModel', () => {
	it('Picks the longest matching model-id prefix', () => {
		expect(priceForModel('claude-opus-4-1-20250805')).toEqual({
			input: 15,
			output: 75,
			cacheRead: 1.5,
			cacheWrite: 18.75,
		})
		expect(priceForModel('claude-3-5-haiku-20241022').input).toBe(0.8)
		expect(priceForModel('claude-haiku-4-5').input).toBe(1)
		expect(priceForModel('claude-sonnet-4-5').input).toBe(3)
	})

	it('Falls back to the Sonnet tier for an unknown model id', () => {
		expect(priceForModel('some-future-model')).toEqual(priceForModel('claude-sonnet-4-5'))
	})

	it('Honours a per-prefix price override', () => {
		const override = { 'claude-sonnet': { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 } }
		expect(priceForModel('claude-sonnet-4-5', override).output).toBe(20)
	})
})

describe('cost', () => {
	it('Bills each bucket at its own rate — output ~5× input, cache-read 0.1×, cache-write 1.25×', () => {
		const usd = cost(
			{
				inputTokens: 1_000_000,
				outputTokens: 100_000,
				cacheReadInputTokens: 2_000_000,
				cacheCreationInputTokens: 400_000,
			},
			'claude-sonnet-4-5'
		)
		// 3 (input) + 1.5 (output) + 0.6 (cache-read) + 1.5 (cache-write)
		expect(usd).toBeCloseTo(6.6, 9)
	})

	it('Treats missing cache buckets as zero', () => {
		expect(cost({ inputTokens: 1_000_000, outputTokens: 0 }, 'claude-opus-4-1')).toBeCloseTo(15, 9)
	})

	it('Charges output far more than the budget metric credits it — the billing bug this fixes', () => {
		// An output-heavy turn: totalTokens counts output 1:1 with input, but cost bills it ~5×
		const usage = { inputTokens: 100_000, outputTokens: 100_000 }
		expect(totalTokens(usage)).toBe(200_000)
		// opus: input $1.5 + output $7.5 — output (5× input) dominates the actual dollar cost
		expect(cost(usage, 'claude-opus-4-1')).toBeCloseTo(1.5 + 7.5, 9)
	})
})

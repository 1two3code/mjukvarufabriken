import {
	defaultModelPrices,
	jobCostUsd,
	priceForModel,
	pricesEffectiveAt,
	rawTokens,
	usageCostUsd,
} from '@mf/models'

/** The pure price math of @mf/models (no test project of its own) — the billing basis */
describe('Model prices', () => {
	const sample = {
		inputTokens: 1_000_000,
		outputTokens: 1_000_000,
		cacheReadInputTokens: 1_000_000,
		cacheCreationInputTokens: 1_000_000,
	}

	it('Picks the longest matching prefix and falls back to the Sonnet tier', () => {
		expect(priceForModel('claude-3-5-haiku-20241022')).toEqual(defaultModelPrices['claude-3-5-haiku'])
		expect(priceForModel('claude-haiku-4-5')).toEqual(defaultModelPrices['claude-haiku'])
		expect(priceForModel('claude-opus-5')).toEqual(defaultModelPrices['claude-opus'])
		expect(priceForModel('something-new')).toEqual(defaultModelPrices['claude-sonnet'])
		expect(priceForModel('unknown', {})).toEqual(defaultModelPrices['claude-sonnet'])
	})

	it('Bills every bucket at its own rate and sums a job over its models', () => {
		expect(usageCostUsd(sample, 'claude-sonnet-5', defaultModelPrices)).toBeCloseTo(
			3 + 15 + 0.3 + 3.75
		)
		expect(
			jobCostUsd({ 'claude-sonnet-5': sample, 'claude-haiku-4-5': sample }, defaultModelPrices)
		).toBeCloseTo(22.05 + 7.35)
		expect(rawTokens({ a: sample, b: sample })).toBe(8_000_000)
	})

	it('pricesEffectiveAt takes the newest row per prefix not after the instant', () => {
		const row = (modelPrefix: string, effectiveFrom: string, input: number) => ({
			id: `${modelPrefix}-${effectiveFrom}`,
			modelPrefix,
			input,
			output: input * 5,
			cacheRead: input / 10,
			cacheWrite: input * 1.25,
			effectiveFrom,
			createdAt: effectiveFrom,
		})
		const rows = [
			row('claude-sonnet', '2026-08-28T00:00:00.000Z', 3),
			row('claude-sonnet', '2026-09-01T00:00:00.000Z', 2),
			row('claude-sonnet', '2026-10-01T00:00:00.000Z', 1),
			row('claude-opus', '2026-08-28T00:00:00.000Z', 15),
		]
		expect(pricesEffectiveAt(rows, new Date('2026-09-15T00:00:00.000Z'))).toEqual({
			'claude-sonnet': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
			'claude-opus': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
		})
	})
})

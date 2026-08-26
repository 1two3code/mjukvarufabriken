import type { ResidentModelUsage } from '@mf/models'

/** USD per million tokens, per bucket */
export type ModelPrice = {
	input: number
	output: number
	cacheRead: number
	cacheWrite: number
}

/**
 * Anthropic list prices (USD / MTok) by model-id prefix, longest prefix wins. Cache reads are
 * 10 % of input and 5-minute cache writes 125 % — the same ratios for every model. Unknown ids
 * fall back to the Sonnet tier so a new model name never bills at zero. Override with
 * `RESIDENT_PRICES_JSON` (`{"<prefix>": {"input": 3, "output": 15}}`) without a redeploy.
 */
export const defaultPrices: Record<string, ModelPrice> = {
	'claude-opus': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
	'claude-sonnet': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	'claude-haiku': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
	'claude-3-5-haiku': { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
}

export const fallbackPrice: ModelPrice = defaultPrices['claude-sonnet']!

/** `{"prefix": {input, output[, cacheRead, cacheWrite]}}`; missing cache prices derive from input */
export const parsePriceOverrides = (json: string | undefined): Record<string, ModelPrice> => {
	if (!json?.trim()) return {}
	const parsed = JSON.parse(json) as Record<string, Partial<ModelPrice>>
	return Object.fromEntries(
		Object.entries(parsed).map(([prefix, price]) => {
			const input = Number(price.input ?? 0)
			return [
				prefix,
				{
					input,
					output: Number(price.output ?? 0),
					cacheRead: Number(price.cacheRead ?? input * 0.1),
					cacheWrite: Number(price.cacheWrite ?? input * 1.25),
				},
			]
		})
	)
}

export const priceOf = (
	model: string,
	prices: Record<string, ModelPrice> = defaultPrices
): ModelPrice => {
	const match = Object.keys(prices)
		.filter(prefix => model.startsWith(prefix))
		.sort((a, b) => b.length - a.length)[0]
	return match ? prices[match]! : fallbackPrice
}

const perMillion = 1_000_000

/** List price in USD of one model's raw token buckets (not the budget-weighted total) */
export const listPriceUsd = (
	model: string,
	usage: Omit<ResidentModelUsage, 'budgetTokens'>,
	prices?: Record<string, ModelPrice>
) => {
	const price = priceOf(model, prices)
	return (
		(usage.inputTokens * price.input +
			usage.outputTokens * price.output +
			usage.cacheReadInputTokens * price.cacheRead +
			usage.cacheCreationInputTokens * price.cacheWrite) /
		perMillion
	)
}

/** Money is kept to 6 decimals in the records (sub-cent precision, no float noise) */
export const roundUsd = (usd: number) => Math.round(usd * 1_000_000) / 1_000_000

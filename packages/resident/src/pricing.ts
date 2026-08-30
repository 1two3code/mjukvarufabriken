import { cost, fallbackModelPrice, modelPrices, priceForModel } from '@mf/harness'

import type { ModelPrice } from '@mf/harness'
import type { ResidentModelUsage } from '@mf/models'

/** USD per million tokens, per bucket — the harness billing primitive, re-exported for the resident */
export type { ModelPrice }

/**
 * Anthropic list prices (USD / MTok) live in `@mf/harness` (`modelPrices`) so the factory and the
 * resident bill off one table. Longest-matching model-id prefix wins; unknown ids fall back to the
 * Sonnet tier. Override a prefix at runtime with `RESIDENT_PRICES_JSON`
 * (`{"<prefix>": {"input": 3, "output": 15}}`) — an override is merged over these defaults, so a
 * partial or empty map still prices every other model at its list rate.
 */
export const defaultPrices: Record<string, ModelPrice> = modelPrices

export const fallbackPrice: ModelPrice = fallbackModelPrice

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

/** Overrides are merged over the harness defaults so a partial/empty map never zeroes a model out */
const withDefaults = (prices?: Record<string, ModelPrice>): Record<string, ModelPrice> =>
	prices ? { ...defaultPrices, ...prices } : defaultPrices

export const priceOf = (
	model: string,
	prices?: Record<string, ModelPrice>
): ModelPrice => priceForModel(model, withDefaults(prices))

/** List price in USD of one model's raw token buckets (not the budget-weighted total) */
export const listPriceUsd = (
	model: string,
	usage: Omit<ResidentModelUsage, 'budgetTokens'>,
	prices?: Record<string, ModelPrice>
) => cost(usage, model, withDefaults(prices))

/** Money is kept to 6 decimals in the records (sub-cent precision, no float noise) */
export const roundUsd = (usd: number) => Math.round(usd * 1_000_000) / 1_000_000

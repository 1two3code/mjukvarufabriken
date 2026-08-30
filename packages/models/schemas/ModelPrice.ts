import { z } from 'zod'

// MARK: Price

/**
 * Anthropic list price of a model, USD per **million** tokens, one rate per bucket. Output bills
 * at its own (higher) rate; cache reads at 0.1× input; 5-minute cache writes at 1.25× input.
 */
export const ModelPriceSchema = z.object({
	/** USD / MTok, uncached input */
	input: z.number().nonnegative(),
	/** USD / MTok, output */
	output: z.number().nonnegative(),
	/** USD / MTok, cache-read input */
	cacheRead: z.number().nonnegative(),
	/** USD / MTok, cache-write input (5-minute TTL) */
	cacheWrite: z.number().nonnegative(),
})
export type ModelPrice = z.infer<typeof ModelPriceSchema>

/** Prices keyed by model-id prefix (`claude-sonnet` matches `claude-sonnet-5`); longest match wins */
export type ModelPrices = Record<string, ModelPrice>

/**
 * The built-in list prices — the seed of the `model_prices` table and the fallback when no table
 * is available (the memory backend, the harness offline). Source: Anthropic pricing, captured
 * 2026-08-28. Operators change prices through the admin (`POST /bff/admin/model-prices`), never
 * here: a new row applies to orders created after its `effectiveFrom`.
 */
export const defaultModelPrices: ModelPrices = {
	'claude-opus': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
	'claude-sonnet': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	'claude-haiku': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
	'claude-3-5-haiku': { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
}

/** Unknown model ids price at the Sonnet tier, so a new model name never bills at zero */
export const fallbackModelPrice: ModelPrice = defaultModelPrices['claude-sonnet']!

/** The price of a model id: the longest matching prefix in `prices`, else the Sonnet fallback */
export const priceForModel = (
	model: string,
	prices: ModelPrices = defaultModelPrices
): ModelPrice => {
	const match = Object.keys(prices)
		.filter(prefix => model.startsWith(prefix))
		.sort((a, b) => b.length - a.length)[0]
	return match ? prices[match]! : fallbackModelPrice
}

// MARK: Usage

/** Raw four-bucket token usage — what Anthropic meters, before any budget weighting */
export const ModelUsageSchema = z.object({
	inputTokens: z.number().int().nonnegative(),
	outputTokens: z.number().int().nonnegative(),
	cacheReadInputTokens: z.number().int().nonnegative(),
	cacheCreationInputTokens: z.number().int().nonnegative(),
})
export type ModelUsage = z.infer<typeof ModelUsageSchema>

/** A job's raw usage per model id (planner and workers may run different models) */
export const JobUsageSchema = z.record(z.string(), ModelUsageSchema)
export type JobUsage = z.infer<typeof JobUsageSchema>

const perMillionTokens = 1_000_000

/** USD cost of one model's raw usage at the given prices — every bucket at its own rate */
export const usageCostUsd = (usage: ModelUsage, model: string, prices: ModelPrices): number => {
	const price = priceForModel(model, prices)
	return (
		(usage.inputTokens * price.input +
			usage.outputTokens * price.output +
			usage.cacheReadInputTokens * price.cacheRead +
			usage.cacheCreationInputTokens * price.cacheWrite) /
		perMillionTokens
	)
}

/** USD cost of a whole job's usage, summed over its models, rounded to a hundredth of a cent */
export const jobCostUsd = (usage: JobUsage, prices: ModelPrices): number =>
	Number(
		Object.entries(usage)
			.reduce((sum, [model, sample]) => sum + usageCostUsd(sample, model, prices), 0)
			.toFixed(4)
	)

/** Raw token total of a job's usage — the figure the Anthropic console shows (cache reads 1:1) */
export const rawTokens = (usage: JobUsage): number =>
	Object.values(usage).reduce(
		(sum, sample) =>
			sum +
			sample.inputTokens +
			sample.outputTokens +
			sample.cacheReadInputTokens +
			sample.cacheCreationInputTokens,
		0
	)

// MARK: Price rows (admin)

/** One row of the price table: a prefix's rates from `effectiveFrom` on */
export const ModelPriceRowSchema = ModelPriceSchema.extend({
	id: z.string(),
	modelPrefix: z.string().min(1).max(100),
	effectiveFrom: z.iso.datetime(),
	createdAt: z.iso.datetime(),
})
export type ModelPriceRow = z.infer<typeof ModelPriceRowSchema>

/** `POST /bff/admin/model-prices`: `effectiveFrom` defaults to now */
export const NewModelPriceSchema = ModelPriceSchema.extend({
	modelPrefix: z.string().trim().min(1).max(100),
	effectiveFrom: z.iso.datetime().optional(),
}).strict()
export type NewModelPrice = z.infer<typeof NewModelPriceSchema>

/**
 * The prices in effect at an instant: per prefix, the row with the latest `effectiveFrom` not
 * after `at`. Rows dated later are ignored, so a price change never reprices earlier orders.
 */
export const pricesEffectiveAt = (rows: ModelPriceRow[], at: Date): ModelPrices => {
	const chosen = new Map<string, ModelPriceRow>()
	for (const row of rows) {
		if (new Date(row.effectiveFrom).getTime() > at.getTime()) continue
		const current = chosen.get(row.modelPrefix)
		if (!current || row.effectiveFrom > current.effectiveFrom) chosen.set(row.modelPrefix, row)
	}
	return Object.fromEntries(
		[...chosen.values()].map(row => [
			row.modelPrefix,
			{ input: row.input, output: row.output, cacheRead: row.cacheRead, cacheWrite: row.cacheWrite },
		])
	)
}

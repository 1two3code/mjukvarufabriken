import { z } from 'zod'

// MARK: Pricing tier

/**
 * One row of the operator-editable pricing-tier table (migration 0019). Modeled closely on
 * `model_prices` (`ModelPrice.ts`): append-only, one row per (`tierKey`, `effectiveFrom`), a
 * later row for the same key takes over from its `effectiveFrom` on.
 *
 * Seeded (migration 0020) with the pricing ladder decided 2026-08-31: `demo` 500 kr,
 * `build_s/m/l` 3–5 k kr (read by `priceEstimator.ts` at spec freeze via `sizePricesFromTiers`),
 * `managed_monthly` 600 kr/mo. An admin reprices by inserting a later row for the same key —
 * no code change needed.
 */
export const PricingTierRowSchema = z.object({
	id: z.string(),
	/** Machine key for the tier, e.g. "free" / "starter" / "subscription" — shape TBD, not an enum */
	tierKey: z.string().min(1).max(100),
	/** Display name, e.g. "Starter" */
	name: z.string().min(1).max(200),
	/** Price in `currency`; a free tier is 0 */
	price: z.number().nonnegative(),
	/** Free-text currency/unit, e.g. "SEK" or "USD" — not constrained to a fixed list yet */
	currency: z.string().trim().min(1).max(10),
	/** Free text: what the tier includes */
	description: z.string().max(2000),
	effectiveFrom: z.iso.datetime(),
	createdAt: z.iso.datetime(),
})
export type PricingTierRow = z.infer<typeof PricingTierRowSchema>

/** `POST /bff/admin/pricing-tiers`: `effectiveFrom` defaults to now */
export const NewPricingTierSchema = PricingTierRowSchema.omit({ id: true, createdAt: true })
	.extend({ effectiveFrom: z.iso.datetime().optional() })
	.strict()
export type NewPricingTier = z.infer<typeof NewPricingTierSchema>

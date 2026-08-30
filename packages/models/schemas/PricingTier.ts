import { z } from 'zod'

// MARK: Pricing tier

/**
 * One row of the operator-editable pricing-tier table (migration 0019). Modeled closely on
 * `model_prices` (`ModelPrice.ts`): append-only, one row per (`tierKey`, `effectiveFrom`), a
 * later row for the same key takes over from its `effectiveFrom` on.
 *
 * This is intentionally just the SHAPE, not a decision — PLAN.md's "Pricing v1" is explicitly
 * under revision (2026-08-30) with no numbers, tier count, or currency settled yet (a possible
 * free tier, a cheap entry tier, an upsell tier, a subscription tier — all still open). Nothing
 * in the app reads this table yet: no order flow, no `priceEstimator.ts`. It only gives an
 * admin a place to type tiers in — and change them — once pricing is decided, without another
 * code change.
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

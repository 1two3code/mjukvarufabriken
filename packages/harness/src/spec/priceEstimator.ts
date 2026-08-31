import type { PartialSpec, PricingTierRow, SizeClass, Spec } from '@mf/models'

/**
 * S/M/L survive as INTERNAL build-size classes (budgets, worker caps, duration limits) but no
 * longer carry a price of their own: the customer price comes from the operator-editable
 * `pricing_tiers` table via `sizePricesFromTiers`, with `priceForSize` as the code fallback.
 */

/** `pricing_tiers` row key that prices a build of each size class (seeded by migration 0020) */
export const tierKeyForSize: Record<SizeClass, string> = {
	S: 'build_s',
	M: 'build_m',
	L: 'build_l',
}

/**
 * Fallback price per size class, SEK ex moms — the decided ladder (strategy 2026-08-31: real
 * build 3–5 k kr by size). Used when the tiers table has no effective row for the size, so the
 * in-memory db and a fresh install price correctly without any seed.
 */
export const priceForSize: Record<SizeClass, number> = { S: 3_000, M: 4_000, L: 5_000 }

/** Hard price ceiling, SEK ex moms: nothing is offered above this (strategy 2026-08-31) */
export const priceCeilingSek = 5_000

/** Price per size class as read from the tiers table; a missing size falls back to `priceForSize` */
export type SizePrices = Partial<Record<SizeClass, number>>

/**
 * The effective build price per size class from the `pricing_tiers` rows: for each size's tier
 * key, the SEK row with the latest `effectiveFrom` that is not in the future wins. Sizes without
 * such a row are left out (the estimator falls back to `priceForSize`).
 */
export const sizePricesFromTiers = (tiers: PricingTierRow[], at = new Date()): SizePrices => {
	const prices: SizePrices = {}
	for (const [size, tierKey] of Object.entries(tierKeyForSize) as [SizeClass, string][]) {
		const effective = tiers
			.filter(tier => tier.tierKey === tierKey && tier.currency === 'SEK')
			.filter(tier => new Date(tier.effectiveFrom).getTime() <= at.getTime())
			.sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0]
		if (effective) prices[size] = Math.round(effective.price)
	}
	return prices
}

const smallMaxFeatures = 3
const smallMaxCriteria = 6
const largeMinFeatures = 8
const largeMinIntegrations = 2

// Keyword signals, sv + en. Matched case-insensitively against feature text.
const paymentsPattern =
	/\b(payment|payments|checkout|stripe|klarna|swish|betalning|betalningar|betala|kortbetalning|faktura|invoice|invoicing|subscription|prenumeration)/i
const authPattern =
	/\b(auth|authentication|login|log in|sign[- ]?in|inloggning|logga in|autentisering|bankid|sso|oauth)/i
const rolesPattern =
	/\b(role|roles|roll|roller|admin|administrat[oö]r|permission|permissions|behörighet|behörigheter|rbac)/i
const integrationPattern =
	/\b(integration|integrations|integrera|integrer\w*|third[- ]party|tredjepart\w*|webhook\w*|external api|externt? api|sync\w*|synk\w*|import\w* from|export\w* to)/i
const realtimePattern =
	/\b(real[- ]?time|realtid\w*|websocket\w*|live[- ](update|feed|data|chat)|push notif\w*|pushnotis\w*|streaming)/i

const featureText = (feature: NonNullable<PartialSpec['features']>[number]) =>
	[feature.title, feature.description, ...feature.acceptanceCriteria].join('\n')

const allText = (spec: PartialSpec) =>
	[
		spec.goal ?? '',
		...(spec.features ?? []).map(featureText),
		...(spec.stackConstraints ?? []),
	].join('\n')

const countCriteria = (spec: PartialSpec) =>
	(spec.features ?? []).reduce((sum, feature) => sum + feature.acceptanceCriteria.length, 0)

/** Number of features that read as a third-party integration */
export const countIntegrations = (spec: PartialSpec) =>
	(spec.features ?? []).filter(feature => integrationPattern.test(featureText(feature))).length

export const hasPayments = (spec: PartialSpec) => paymentsPattern.test(allText(spec))
export const hasAuthWithRoles = (spec: PartialSpec) => {
	const text = allText(spec)
	return authPattern.test(text) && rolesPattern.test(text)
}
export const hasRealtime = (spec: PartialSpec) => realtimePattern.test(allText(spec))

/**
 * Deterministic size classification.
 * - S: ≤ 3 features and ≤ 6 acceptance criteria in total
 * - L: ≥ 8 features, or any of payments / auth with roles / ≥ 2 integrations / realtime
 * - M: everything else
 */
export const sizeClass = (spec: PartialSpec): SizeClass => {
	const features = spec.features ?? []
	const isLarge =
		features.length >= largeMinFeatures ||
		hasPayments(spec) ||
		hasAuthWithRoles(spec) ||
		countIntegrations(spec) >= largeMinIntegrations ||
		hasRealtime(spec)
	if (isLarge) return 'L'
	if (features.length <= smallMaxFeatures && countCriteria(spec) <= smallMaxCriteria) return 'S'
	return 'M'
}

export type PriceEstimate = { sizeClass: SizeClass; priceSek: number }

/**
 * Prices the spec: size class from the deterministic classifier, price from the tiers table
 * (`prices`, see `sizePricesFromTiers`) with `priceForSize` as fallback. The hard ceiling is
 * applied last, so not even a mistyped tier row can quote above it.
 */
export const estimatePrice = (spec: Spec | PartialSpec, prices: SizePrices = {}): PriceEstimate => {
	const size = sizeClass(spec)
	return { sizeClass: size, priceSek: Math.min(prices[size] ?? priceForSize[size], priceCeilingSek) }
}

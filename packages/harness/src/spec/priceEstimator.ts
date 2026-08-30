import type { PartialSpec, SizeClass, Spec } from '@mf/models'

/** Fixed price per size class, SEK ex moms (PLAN.md decision 2026-08-26) */
export const priceForSize: Record<SizeClass, number> = { S: 15_000, M: 45_000, L: 120_000 }

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

export const estimatePrice = (spec: Spec | PartialSpec): PriceEstimate => {
	const size = sizeClass(spec)
	return { sizeClass: size, priceSek: priceForSize[size] }
}

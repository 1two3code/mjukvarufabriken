import {
	AcceptanceReportSchema,
	LicenceGateDetailsSchema,
	ReviewFindingSchema,
	reviewSeverity,
} from '@mf/models'

import type {
	AcceptanceStatus,
	GateReport,
	LicenceGateDetails,
	ReviewFinding,
	ReviewSeverity,
} from '@mf/models'

/** First line of a gate's summary — what the collapsed row on the order page shows */
export const gateHeadline = (summary: string) =>
	summary
		.split('\n')
		.find(line => line.trim())
		?.trim() ?? ''

/** `details` is free-form per gate: scalars inline, anything else pretty-printed */
export const formatGateDetail = (value: unknown) =>
	typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
		? String(value)
		: JSON.stringify(value, null, 2)

const asRecord = (value: unknown): Record<string, unknown> =>
	value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {}

const asStringArray = (value: unknown): string[] =>
	Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

// MARK: Review (independent-review gate)
export type ReviewGateSummary = {
	findings: ReviewFinding[]
	/** Number of findings per severity, in `reviewSeverity` order */
	counts: Record<ReviewSeverity, number>
	/** Findings whose id an admin waived, matched to the finding set shown (post-fix when present) */
	waived: number
}

/**
 * The review gate's `details.findings` (post-fix findings when it ran a fix pass) reduced to a
 * per-severity tally. Undefined when the gate carries no parseable findings.
 */
export const reviewGateSummary = (gate: GateReport): ReviewGateSummary | undefined => {
	const details = asRecord(gate.details)
	// The fix pass re-reviews: `findingsAfterFix` is the final state, else the first `findings`
	const raw = Array.isArray(details.findingsAfterFix)
		? details.findingsAfterFix
		: Array.isArray(details.findings)
			? details.findings
			: undefined
	if (!raw) return undefined

	const findings = raw.flatMap(item => {
		const parsed = ReviewFindingSchema.safeParse(item)
		return parsed.success ? [parsed.data] : []
	})
	const counts = Object.fromEntries(reviewSeverity.map(severity => [severity, 0])) as Record<
		ReviewSeverity,
		number
	>
	for (const finding of findings) counts[finding.severity] += 1

	// Prefer the post-fix waiver set (`waiversAfterFix`) so the count matches the post-fix findings
	// shown above; the harness only writes `waiversAfterFix` when a fix pass ran, else `waived` holds.
	const waived = asStringArray(details.waiversAfterFix ?? details.waived).length
	return { findings, counts, waived }
}

// MARK: Licence (third-party-licences gate)
/** The licence gate's `details`, when it parses as the licence-gate shape */
export const licenceGateSummary = (gate: GateReport): LicenceGateDetails | undefined => {
	const parsed = LicenceGateDetailsSchema.safeParse(gate.details)
	return parsed.success ? parsed.data : undefined
}

// MARK: Acceptance check (acceptance-check gate)
export type AcceptanceGateEntry = { id: string; status: AcceptanceStatus }

/**
 * The acceptance-check gate's `details.report` as a criterion → status list, in numeric feature
 * order. Ids are `f<n>.c<m>`, so a plain lexical sort would put `f10.c0` before `f2.c0`; the
 * `numeric` collation compares each digit run as a number so feature 10 follows feature 9.
 */
export const acceptanceGateSummary = (gate: GateReport): AcceptanceGateEntry[] | undefined => {
	const parsed = AcceptanceReportSchema.safeParse(asRecord(gate.details).report)
	if (!parsed.success) return undefined
	return Object.entries(parsed.data)
		.map(([id, evidence]) => ({ id, status: evidence.status }))
		.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
}

/** Detail keys the structured renderers already cover, so the generic fallback skips them */
const structuredDetailKeys = new Set([
	'findings',
	'findingsAfterFix',
	'waived',
	'waiversAfterFix',
	'report',
	'packages',
	'byLicence',
	'violations',
	'missing',
	'range',
])

/**
 * `details` entries not shown by a structured renderer, so admins still see gate internals
 * (verify/acceptance-test output, fix flags) without a raw dump of what is already rendered.
 */
export const genericGateDetails = (gate: GateReport): [string, unknown][] =>
	Object.entries(asRecord(gate.details)).filter(([key]) => !structuredDetailKeys.has(key))

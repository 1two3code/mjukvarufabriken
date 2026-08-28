import { totalTokens } from './types.ts'

import type { TokenUsage } from './types.ts'

/**
 * The Agent SDK emits one `assistant` message per content block of an API turn, each carrying
 * that turn's (cumulative) `usage`. Counting every message would multiply a turn's usage by its
 * block count, so usage is keyed by API message id and only the growth since the last sighting
 * of that id is reported.
 */
/** The per-bucket growth since a message id was last seen (each bucket is cumulative within a turn) */
const bucketDelta = (before: TokenUsage | undefined, now: TokenUsage): TokenUsage => ({
	inputTokens: now.inputTokens - (before?.inputTokens ?? 0),
	outputTokens: now.outputTokens - (before?.outputTokens ?? 0),
	cacheReadInputTokens: (now.cacheReadInputTokens ?? 0) - (before?.cacheReadInputTokens ?? 0),
	cacheCreationInputTokens:
		(now.cacheCreationInputTokens ?? 0) - (before?.cacheCreationInputTokens ?? 0),
})

export const createUsageAccumulator = (onUsage: (usage: TokenUsage) => void) => {
	// The last raw usage seen per API message id, so a re-sighting reports only the per-bucket growth
	const seen = new Map<string, TokenUsage>()
	let total = 0

	return {
		/** Report a message's usage; returns the (budget-weighted) delta counted against the budget */
		add: (messageId: string, usage: TokenUsage) => {
			const before = seen.get(messageId)
			const now = totalTokens(usage)
			const delta = now - (before ? totalTokens(before) : 0)
			if (delta <= 0) return 0
			seen.set(messageId, usage)
			total += delta
			// Emit the RAW four-bucket delta, not a collapsed scalar: the budget re-weights it through
			// `totalTokens` (cache reads at 0.1×), so the cap is unchanged, while cost()/metering see the
			// true input/output/cache buckets and can bill each at its own rate.
			onUsage(bucketDelta(before, usage))
			return delta
		},
		/** Raise the total to an authoritative figure (the final result's modelUsage) */
		reconcile: (reported: number) => {
			const missing = reported - total
			if (missing <= 0) return 0
			total += missing
			// The result-level top-up (subagents, compaction) carries no bucket breakdown, so attribute
			// it to input: it weights 1:1 for the budget and prices as input for cost.
			onUsage({ inputTokens: missing, outputTokens: 0 })
			return missing
		},
		get total() {
			return total
		},
	}
}

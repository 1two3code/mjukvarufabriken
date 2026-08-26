import { totalTokens } from './types.ts'

import type { TokenUsage } from './types.ts'

/**
 * The Agent SDK emits one `assistant` message per content block of an API turn, each carrying
 * that turn's (cumulative) `usage`. Counting every message would multiply a turn's usage by its
 * block count, so usage is keyed by API message id and only the growth since the last sighting
 * of that id is reported.
 */
export const createUsageAccumulator = (onUsage: (usage: TokenUsage) => void) => {
	const seen = new Map<string, number>()
	let total = 0

	return {
		/** Report a message's usage; returns the delta counted against the budget */
		add: (messageId: string, usage: TokenUsage) => {
			const before = seen.get(messageId) ?? 0
			const now = totalTokens(usage)
			const delta = now - before
			if (delta <= 0) return 0
			seen.set(messageId, now)
			total += delta
			// Attribute the delta to input tokens: `onUsage` consumers only sum buckets
			onUsage({ inputTokens: delta, outputTokens: 0 })
			return delta
		},
		/** Raise the total to an authoritative figure (the final result's modelUsage) */
		reconcile: (reported: number) => {
			const missing = reported - total
			if (missing <= 0) return 0
			total += missing
			onUsage({ inputTokens: missing, outputTokens: 0 })
			return missing
		},
		get total() {
			return total
		},
	}
}

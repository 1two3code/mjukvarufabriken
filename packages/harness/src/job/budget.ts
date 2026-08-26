import { totalTokens } from './types.ts'

import type { JobBudget } from '@mf/models'
import type { TokenUsage } from './types.ts'

export type AbortReason = 'budget exceeded' | 'duration exceeded' | 'killed'

/**
 * Hard token + wall-clock budget shared by every session in a job. The first breach aborts the
 * shared `AbortController` (every in-flight Agent SDK / Anthropic call listens to it) and records
 * the reason so the orchestrator can report it.
 */
export class BudgetTracker {
	readonly controller = new AbortController()
	private tokens = 0
	private abortReason: AbortReason | undefined
	private readonly startedAt: number
	private readonly budget: JobBudget
	private readonly now: () => number

	constructor(budget: JobBudget, now: () => number = Date.now) {
		this.budget = budget
		this.now = now
		this.startedAt = now()
	}

	get signal() {
		return this.controller.signal
	}

	get used() {
		return this.tokens
	}

	get reason() {
		return this.abortReason
	}

	get aborted() {
		return this.controller.signal.aborted
	}

	/** Count a message's usage; aborts once the cap is crossed */
	add(usage: TokenUsage) {
		this.tokens += totalTokens(usage)
		if (this.tokens > this.budget.maxTokens) this.abort('budget exceeded')
	}

	/** Set the total for a session that reports authoritative usage at the end */
	adjust(delta: number) {
		if (delta <= 0) return
		this.tokens += delta
		if (this.tokens > this.budget.maxTokens) this.abort('budget exceeded')
	}

	/** Re-check the wall clock; call it from the poll loop and before starting new work */
	checkDuration() {
		const elapsedMinutes = (this.now() - this.startedAt) / 60_000
		if (elapsedMinutes > this.budget.maxDurationMinutes) this.abort('duration exceeded')
	}

	abort(reason: AbortReason) {
		if (this.abortReason) return
		this.abortReason = reason
		this.controller.abort(new Error(reason))
	}
}

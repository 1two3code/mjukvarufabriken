import { addUsage, emptyUsage, totalTokens } from './types.ts'

import type { JobBudget, JobUsage } from '@mf/models'
import type { TokenUsage } from './types.ts'

/** The usage key when a sample arrives without a model id */
export const unknownModel = 'unknown'

export type AbortReason = 'budget exceeded' | 'duration exceeded' | 'killed'

/**
 * Hard token + wall-clock budget shared by every session in a job. The first breach aborts the
 * shared `AbortController` (every in-flight Agent SDK / Anthropic call listens to it) and records
 * the reason so the orchestrator can report it.
 */
export class BudgetTracker {
	readonly controller = new AbortController()
	private tokens = 0
	/** Weighted tokens observed at the egress chokepoint (forward proxy) — see `addObserved` */
	private observedTokens = 0
	/** Raw four-bucket usage per model — never weighted, the billing basis */
	private readonly usageByModel: JobUsage = {}
	private abortReason: AbortReason | undefined
	private readonly startedAt: number
	private readonly budget: JobBudget
	private readonly now: () => number
	/** Wall-clock milliseconds already excluded from the duration budget (finished pauses) */
	private pausedMs = 0
	/** When the clock is currently paused, the instant the pause began; undefined when running */
	private pauseStartedAt: number | undefined

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

	/** Raw usage per model so far (a copy) */
	get usage(): JobUsage {
		return structuredClone(this.usageByModel)
	}

	get reason() {
		return this.abortReason
	}

	get aborted() {
		return this.controller.signal.aborted
	}

	/**
	 * Count a message's usage; aborts once the cap is crossed. `model` attributes the raw sample
	 * for billing (`unknown` when the caller cannot tell — priced at the fallback tier).
	 */
	add(usage: TokenUsage, model = unknownModel) {
		this.tokens += totalTokens(usage)
		this.usageByModel[model] = addUsage(this.usageByModel[model] ?? emptyUsage(), usage)
		if (this.tokens > this.budget.maxTokens) this.abort('budget exceeded')
	}

	/**
	 * Count usage observed at the egress chokepoint (the job's Anthropic forward proxy — hardening
	 * audit 2026-08-30, Gate B finding D1). The proxy sees EVERY request that reaches the API —
	 * the SDK sessions' own traffic (already counted via `add`/`adjust`) AND any out-of-band call a
	 * prompt-injected worker makes with `curl` against `ANTHROPIC_BASE_URL`. The two ledgers
	 * therefore overlap almost completely, so this is a SEPARATE total that is never added to
	 * `used`/`usage` (no double counting of the budget or the billing basis): because the
	 * proxy-observed total is a superset of the SDK-counted one, checking it alone against the cap
	 * is exactly `max(sdkCounted, proxyObserved) > maxTokens` — out-of-band spend inflates it past
	 * the cap and trips the same abort the SDK path uses.
	 */
	addObserved(usage: TokenUsage) {
		this.observedTokens += totalTokens(usage)
		if (this.observedTokens > this.budget.maxTokens) this.abort('budget exceeded')
	}

	/** Weighted tokens the egress proxy has observed (superset of `used`; enforcement, not billing) */
	get observed() {
		return this.observedTokens
	}

	/** Set the total for a session that reports authoritative usage at the end */
	adjust(delta: number) {
		if (delta <= 0) return
		this.tokens += delta
		if (this.tokens > this.budget.maxTokens) this.abort('budget exceeded')
	}

	/**
	 * Stop the wall-clock budget from running (W9). The approve-before-deliver hold can park a job
	 * for as long as a human takes to approve; that wait is not compute, so it must not count
	 * against `maxDurationMinutes`. The kill switch (`abort('killed')`) still fires while paused —
	 * only the duration budget is frozen. Idempotent; a second call while paused is a no-op.
	 */
	pauseClock() {
		if (this.pauseStartedAt === undefined) this.pauseStartedAt = this.now()
	}

	/** Resume the wall-clock budget, banking the paused span so it is never charged. Idempotent. */
	resumeClock() {
		if (this.pauseStartedAt === undefined) return
		this.pausedMs += this.now() - this.pauseStartedAt
		this.pauseStartedAt = undefined
	}

	/** Re-check the wall clock; call it from the poll loop and before starting new work */
	checkDuration() {
		const pausedNow = this.pauseStartedAt === undefined ? 0 : this.now() - this.pauseStartedAt
		const elapsedMinutes = (this.now() - this.startedAt - this.pausedMs - pausedNow) / 60_000
		if (elapsedMinutes > this.budget.maxDurationMinutes) this.abort('duration exceeded')
	}

	abort(reason: AbortReason) {
		if (this.abortReason) return
		this.abortReason = reason
		this.controller.abort(new Error(reason))
	}
}

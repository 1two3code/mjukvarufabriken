import { defaultModelPrices, usageCostUsd } from '@mf/models'

import type {
	Deliverable,
	GateReport,
	Job,
	JobBudget,
	JobUsage,
	ModelPrices,
	NewJobEvent,
	Plan,
	Spec,
	Task,
} from '@mf/models'
import type { DeliveryOutcome, DeliveryTarget } from './delivery/types.ts'

/** Input the orchestrator needs — a subset of the stored `Job` row */
export type JobInput = Pick<Job, 'id' | 'spec' | 'budget' | 'gateWaivers'> & {
	/** Path of the (already initialised) customer git repository the job works in */
	repoDir: string
	/** Commit the repo was seeded from; the review gate diffs `seedCommit..main` (default: root) */
	seedCommit?: string
	/** Where to deliver after green gates (M5); without it the job ends at the gates */
	delivery?: DeliveryTarget
	/**
	 * Approve-before-deliver hold (W9): when true, a job that reaches green gates with a delivery
	 * target PAUSES before the delivery step and waits for `hooks.isApproved` to go true instead of
	 * auto-delivering. Default (undefined/false) leaves the auto-deliver path byte-identical.
	 */
	approveBeforeDeliver?: boolean
}

export type JobOutcome = {
	status: 'delivered' | 'failed' | 'killed'
	tokensUsed: number
	/** Raw four-bucket usage per model — the billing basis, persisted by the job */
	usage: JobUsage
	plan?: Plan
	reason?: string
	/** Reports of the gates that ran, in order (empty when the build never reached them) */
	gates: GateReport[]
	/** Repo URL, deploy URL and bundle location once delivered (M5) */
	deliverable?: Deliverable
}

/** Token usage of one model message, all buckets counted against the budget */
export type TokenUsage = {
	inputTokens: number
	outputTokens: number
	cacheReadInputTokens?: number
	cacheCreationInputTokens?: number
}

/**
 * Cache reads count at 10 % — the same weight Anthropic bills them at. Every agent turn re-reads
 * its whole cached context, so counting them 1:1 would exhaust any budget in a handful of turns
 * without reflecting cost.
 */
export const cacheReadWeight = 0.1

export const totalTokens = (usage: TokenUsage) =>
	Math.round(
		usage.inputTokens +
			usage.outputTokens +
			(usage.cacheCreationInputTokens ?? 0) +
			(usage.cacheReadInputTokens ?? 0) * cacheReadWeight
	)

// MARK: Cost

/** Every bucket present — the shape usage is summed in */
export type UsageTotals = Required<TokenUsage>

export const emptyUsage = (): UsageTotals => ({
	inputTokens: 0,
	outputTokens: 0,
	cacheReadInputTokens: 0,
	cacheCreationInputTokens: 0,
})

export const addUsage = (a: TokenUsage, b: TokenUsage): UsageTotals => ({
	inputTokens: a.inputTokens + b.inputTokens,
	outputTokens: a.outputTokens + b.outputTokens,
	cacheReadInputTokens: (a.cacheReadInputTokens ?? 0) + (b.cacheReadInputTokens ?? 0),
	cacheCreationInputTokens: (a.cacheCreationInputTokens ?? 0) + (b.cacheCreationInputTokens ?? 0),
})

/**
 * Per-model list prices live in `@mf/models` (`defaultModelPrices`, the seed of the api's
 * `model_prices` table) and drive **billing** (`cost`), never the budget cap (`totalTokens`).
 * Re-exported here so the harness and the resident keep their `@mf/harness` import.
 */
export { defaultModelPrices as modelPrices, fallbackModelPrice, priceForModel } from '@mf/models'
export type { ModelPrice } from '@mf/models'

/**
 * Actual USD **cost** of a usage sample at a model's list prices — the billing basis, distinct
 * from `totalTokens` (the budget-cap metric, kept unchanged). Every bucket bills at its own rate:
 * output ~5× input, cache reads 0.1×, cache writes 1.25×. Resident metering multiplies this by the
 * markup to bill; the cap still counts weighted `totalTokens` only.
 */
export const cost = (
	usage: TokenUsage,
	model: string,
	prices: ModelPrices = defaultModelPrices
): number => usageCostUsd(addUsage(emptyUsage(), usage), model, prices)

/** Usage attributed to the model that produced it; `model` is absent when the caller cannot tell */
export type OnUsage = (usage: TokenUsage, model?: string) => void

export type TaskOutcome = {
	ok: boolean
	tokens: number
	/** Branch that holds the work (task/<id>) */
	branch: string
	/** Short explanation when `ok` is false */
	reason?: string
	/** What an audit should see even when `ok`: turn caps hit, gate widened beyond the areas */
	notes?: string[]
}

export type MergeOutcome = {
	ok: boolean
	tokens: number
	reason?: string
}

export type VerifyOutcome = {
	ok: boolean
	output: string
}

/** What every model-driven gate gets; `plan` is absent when gates run stand-alone (gates-demo) */
export type GateInput = {
	spec: Spec
	plan?: Plan
	repoDir: string
	/** Commit the review gate diffs against; empty/absent falls back to the repo's root commit */
	seedCommit?: string
	/** Review finding ids waived by an admin (`Job.gateWaivers`) */
	waivers: string[]
	signal: AbortSignal
	onUsage: OnUsage
}

export type GateOutcome = {
	ok: boolean
	tokens: number
	summary: string
	details?: Record<string, unknown>
}

export type GatePort = (input: GateInput) => Promise<GateOutcome>

/** Everything the orchestrator calls out to — swapped for fakes in tests */
export type OrchestratorPorts = {
	plan: (input: {
		spec: Spec
		signal: AbortSignal
		onUsage: OnUsage
	}) => Promise<Plan>
	runTask: (input: {
		task: Task
		spec: Spec
		plan: Plan
		repoDir: string
		signal: AbortSignal
		onUsage: OnUsage
	}) => Promise<TaskOutcome>
	mergeTask: (input: {
		task: Task
		branch: string
		spec: Spec
		repoDir: string
		signal: AbortSignal
		onUsage: OnUsage
	}) => Promise<MergeOutcome>
	verify: (input: { repoDir: string; signal: AbortSignal }) => Promise<VerifyOutcome>
	/** M4 gates, run after `verify` in this order; each one fails closed */
	acceptanceTests: GatePort
	review: GatePort
	/** Deterministic dependency-licence check; defaults to the built-in `licenceGate` (fakes in tests) */
	licence?: GatePort
	acceptanceCheck: GatePort
	/** M5 delivery after green gates; optional so gates-only runs (gates-demo) need no clients */
	deliver?: (input: DeliveryPortInput) => Promise<DeliveryOutcome>
}

export type DeliveryPortInput = {
	jobId: string
	/** Names the preview service (a redelivery passes its SOURCE job here); defaults to `jobId` */
	serviceJobId?: string
	spec: Spec
	plan?: Plan
	gates: GateReport[]
	repoDir: string
	target: DeliveryTarget
	signal: AbortSignal
	onUsage: OnUsage
	emit: (event: NewJobEvent) => Promise<void>
}

export type OrchestratorHooks = {
	/** Persist an event (planned, task_started, …). Awaited; failures are logged, not fatal. */
	emit: (event: NewJobEvent) => Promise<void>
	/** Persist the running (budget-weighted) token total + raw usage per model (called after every task/merge) */
	onTokens?: (tokensUsed: number, usage: JobUsage) => Promise<void>
	/** Polled every `pollIntervalMs`; returning true aborts the job with status `killed` */
	isKilled?: () => Promise<boolean>
	/**
	 * Called once at start with a report function for usage observed at the job's Anthropic
	 * forward proxy (hardening audit 2026-08-30, Gate B finding D1). Everything fed into it counts
	 * against the token budget on a separate proxy-observed ledger (`BudgetTracker.addObserved`) —
	 * a superset of the SDK-counted total, so out-of-band `curl` spend a worker makes directly
	 * against the proxy burns the same budget and trips the same abort, without double counting
	 * the SDK sessions' own traffic.
	 */
	attachProxyUsage?: (report: OnUsage) => void
	/**
	 * Called once when the job reaches the approve-before-deliver hold (W9), before it starts
	 * waiting — the container persists the awaiting-approval state so the api can expose it.
	 */
	onAwaitingApproval?: () => Promise<void>
	/**
	 * Polled while the job is held at the approve-before-deliver gate (W9); returning true resumes
	 * it into delivery. Absent (or never true) leaves the job parked until it is killed or its
	 * wall-clock budget runs out.
	 */
	isApproved?: () => Promise<boolean>
	pollIntervalMs?: number
}

export type RunJobOptions = {
	ports: OrchestratorPorts
	hooks: OrchestratorHooks
	now?: () => number
}

export type { JobBudget }

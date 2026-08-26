import type {
	Deliverable,
	GateReport,
	Job,
	JobBudget,
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
}

export type JobOutcome = {
	status: 'delivered' | 'failed' | 'killed'
	tokensUsed: number
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
	seedCommit?: string
	/** Review finding ids waived by an admin (`Job.gateWaivers`) */
	waivers: string[]
	signal: AbortSignal
	onUsage: (usage: TokenUsage) => void
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
		onUsage: (usage: TokenUsage) => void
	}) => Promise<Plan>
	runTask: (input: {
		task: Task
		spec: Spec
		plan: Plan
		repoDir: string
		signal: AbortSignal
		onUsage: (usage: TokenUsage) => void
	}) => Promise<TaskOutcome>
	mergeTask: (input: {
		task: Task
		branch: string
		spec: Spec
		repoDir: string
		signal: AbortSignal
		onUsage: (usage: TokenUsage) => void
	}) => Promise<MergeOutcome>
	verify: (input: { repoDir: string; signal: AbortSignal }) => Promise<VerifyOutcome>
	/** M4 gates, run after `verify` in this order; each one fails closed */
	acceptanceTests: GatePort
	review: GatePort
	acceptanceCheck: GatePort
	/** M5 delivery after green gates; optional so gates-only runs (gates-demo) need no clients */
	deliver?: (input: DeliveryPortInput) => Promise<DeliveryOutcome>
}

export type DeliveryPortInput = {
	jobId: string
	spec: Spec
	plan?: Plan
	gates: GateReport[]
	repoDir: string
	target: DeliveryTarget
	signal: AbortSignal
	onUsage: (usage: TokenUsage) => void
	emit: (event: NewJobEvent) => Promise<void>
}

export type OrchestratorHooks = {
	/** Persist an event (planned, task_started, …). Awaited; failures are logged, not fatal. */
	emit: (event: NewJobEvent) => Promise<void>
	/** Persist the running token total (called after every task/merge) */
	onTokens?: (tokensUsed: number) => Promise<void>
	/** Polled every `pollIntervalMs`; returning true aborts the job with status `killed` */
	isKilled?: () => Promise<boolean>
	pollIntervalMs?: number
}

export type RunJobOptions = {
	ports: OrchestratorPorts
	hooks: OrchestratorHooks
	now?: () => number
}

export type { JobBudget }

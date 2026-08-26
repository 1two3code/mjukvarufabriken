/**
 * Orchestrator skeleton. In M3 this becomes the Claude Agent SDK driver that turns a frozen
 * spec into a plan → task DAG → parallel workers → merged repo, under a hard token budget.
 * No runtime dependencies yet — the SDK is added when M3 starts.
 */

export type JobSpec = {
	/** Order/job id from @mf/db */
	jobId: string
	/** Frozen, signed-off structured spec (shape defined in M2) */
	spec: {
		goal: string
		users: string[]
		features: string[]
		nonGoals: string[]
		acceptanceCriteria: string[]
		stackConstraints: string[]
	}
	/** Git repository the job works in */
	repositoryUrl: string
}

export type JobBudget = {
	/** Hard cap on total tokens (input + output) for the whole job */
	maxTokens: number
	/** Wall-clock limit for the job */
	maxDurationMinutes: number
	/** Maximum number of parallel workers */
	maxWorkers: number
}

export const JobStatus = ['queued', 'planning', 'building', 'verifying', 'delivered', 'failed'] as const
export type JobStatus = (typeof JobStatus)[number]

export type JobResult = {
	jobId: string
	status: JobStatus
	tokensUsed: number
	/** Human-readable reason when `status` is `failed` */
	reason?: string
}

/**
 * Run a build job. Placeholder: returns `failed` with a reason until M3 wires the Agent SDK.
 */
export const runJob = async (spec: JobSpec, budget: JobBudget): Promise<JobResult> => {
	if (budget.maxTokens <= 0) {
		return { jobId: spec.jobId, status: 'failed', tokensUsed: 0, reason: 'Empty token budget' }
	}
	return { jobId: spec.jobId, status: 'failed', tokensUsed: 0, reason: 'Harness not implemented (M3)' }
}

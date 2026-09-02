import { BudgetTracker } from './budget.ts'

import type { GateReport, Plan, Spec } from '@mf/models'
import type { DeliveryTarget } from './delivery/types.ts'
import type { JobBudget, JobOutcome, OrchestratorHooks, OrchestratorPorts } from './types.ts'

/**
 * A redelivery: the delivery half of a job — handover docs, secret scan, repo push, deploy, live
 * acceptance, bundle — run again over a repository an earlier job of the same order already
 * built and delivered. No plan, no workers, no gates: those all passed once, and the repository
 * is the proof. It exists because dogfood run 7 (2026-09-02) passed every gate, delivered its
 * repository, and then lost the deploy to an IAM defect — and the only retry was a full rebuild
 * from the spec (~USD 17 of worker tokens) for a failure that lived entirely on the hosting side.
 */
export type RedeliveryInput = {
	/** This redelivery job (events, tokens and the bundle are recorded under it) */
	id: string
	/** The job whose repository is delivered again — names its Express service, database and role */
	sourceJobId: string
	spec: Spec
	/** The source job's plan: the handover docs and prose are written from it */
	plan?: Plan
	/** The source job's gate reports, for the same docs */
	gates?: GateReport[]
	budget: JobBudget
	/** A fresh clone of the source job's repository */
	repoDir: string
	delivery: DeliveryTarget
}

export type RunRedeliveryOptions = {
	ports: Pick<OrchestratorPorts, 'deliver'>
	hooks: Pick<OrchestratorHooks, 'emit' | 'onTokens' | 'isKilled' | 'pollIntervalMs'>
	now?: () => number
}

export const runRedelivery = async (
	job: RedeliveryInput,
	{ ports, hooks, now = Date.now }: RunRedeliveryOptions
): Promise<JobOutcome> => {
	const budget = new BudgetTracker(job.budget, now)
	const emit = (event: Parameters<typeof hooks.emit>[0]) => hooks.emit(event).catch(() => {})
	const gates = job.gates ?? []

	const persistTokens = async () => {
		if (hooks.onTokens) await hooks.onTokens(budget.used, budget.usage).catch(() => {})
	}
	const finish = async (
		outcome: Pick<JobOutcome, 'status' | 'reason' | 'deliverable'>
	): Promise<JobOutcome> => {
		clearInterval(poll)
		await persistTokens()
		const result: JobOutcome = {
			...outcome,
			plan: job.plan,
			tokensUsed: budget.used,
			usage: budget.usage,
			gates,
		}
		if (result.status === 'delivered') {
			await emit({
				type: 'done',
				payload: {
					tokensUsed: result.tokensUsed,
					repositoryUrl: result.deliverable?.repositoryUrl,
					deployUrl: result.deliverable?.deployUrl,
					reason: result.reason,
				},
			})
		} else {
			await emit({
				type: result.status,
				payload: { reason: result.reason, tokensUsed: result.tokensUsed },
			})
		}
		return result
	}
	// The same kill switch a build has: the api flips the row, the next poll aborts the delivery
	const poll = setInterval(() => {
		hooks.isKilled?.()
			.then(killed => killed && budget.abort('killed'))
			.catch(() => {})
	}, hooks.pollIntervalMs ?? 10_000)

	await emit({
		type: 'started',
		payload: { budget: job.budget, mode: 'redeliver', sourceJobId: job.sourceJobId },
	})
	if (!ports.deliver) return finish({ status: 'failed', reason: 'delivery is not configured' })
	if (!job.plan) {
		return finish({
			status: 'failed',
			reason: `source job ${job.sourceJobId} has no plan to write the handover docs from`,
		})
	}

	let delivery
	try {
		delivery = await ports.deliver({
			jobId: job.id,
			serviceJobId: job.sourceJobId,
			spec: job.spec,
			plan: job.plan,
			gates,
			repoDir: job.repoDir,
			target: job.delivery,
			signal: budget.signal,
			onUsage: usage => budget.add(usage),
			emit: hooks.emit,
		})
	} catch (error) {
		delivery = { ok: false, tokens: 0, reason: (error as Error).message, steps: [] }
	}
	if (budget.aborted) {
		return finish({
			status: budget.reason === 'killed' ? 'killed' : 'failed',
			reason: budget.reason,
		})
	}
	if (!delivery.ok) {
		return finish({ status: 'failed', reason: `delivery failed: ${delivery.reason}` })
	}
	// A withheld preview URL keeps its reason on the outcome (see the orchestrator's finish)
	return finish({ status: 'delivered', deliverable: delivery.deliverable, reason: delivery.reason })
}

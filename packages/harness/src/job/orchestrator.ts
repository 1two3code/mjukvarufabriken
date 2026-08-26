import { BudgetTracker } from './budget.ts'
import { blockedBy, readyTasks } from './dag.ts'
import { failureNotification, gatesFailedReason, runGates } from './gates.ts'

import type { Deliverable, GateReport, Plan, Task } from '@mf/models'
import type { JobInput, JobOutcome, RunJobOptions, TokenUsage } from './types.ts'

/**
 * Drives one job: plan → schedule ready tasks up to `maxWorkers` in parallel → merge each finished
 * branch into main in dependency order (a task only becomes ready once its dependencies are
 * merged) → the QA gates on main (verify → acceptance-tests → review → acceptance-check, see
 * `gates.ts`). Every model call reports usage to one `BudgetTracker`; the first breach of tokens,
 * wall clock or the kill switch aborts everything in flight. Anything but green gates ends in
 * `failed`/`killed` plus a `notify` event for the admins.
 */
export const runJob = async (
	job: JobInput,
	{ ports, hooks, now = Date.now }: RunJobOptions
): Promise<JobOutcome> => {
	const budget = new BudgetTracker(job.budget, now)
	const { signal } = budget
	const emit = (event: Parameters<typeof hooks.emit>[0]) => hooks.emit(event).catch(() => {})
	const persistTokens = () => hooks.onTokens?.(budget.used).catch(() => {})
	const onUsage = (usage: TokenUsage) => budget.add(usage)

	// Poll the kill switch + wall clock while work is in flight
	const poll = setInterval(async () => {
		budget.checkDuration()
		if (budget.aborted) return
		if (hooks.isKilled && (await hooks.isKilled().catch(() => false))) budget.abort('killed')
	}, hooks.pollIntervalMs ?? 10_000)

	const gates: GateReport[] = []
	let deliverable: Deliverable | undefined

	const finish = async (outcome: Omit<JobOutcome, 'tokensUsed' | 'gates'>): Promise<JobOutcome> => {
		clearInterval(poll)
		await persistTokens()
		const result = { ...outcome, tokensUsed: budget.used, gates, deliverable }
		if (result.status === 'delivered') {
			await emit({
				type: 'done',
				payload: {
					tokensUsed: result.tokensUsed,
					repositoryUrl: deliverable?.repositoryUrl,
					deployUrl: deliverable?.deployUrl,
				},
			})
		} else {
			await emit({
				type: result.status,
				payload: { reason: result.reason, tokensUsed: result.tokensUsed },
			})
			await emit({
				type: 'notify',
				payload: failureNotification(job.id, result.status, result.reason, gates),
			})
		}
		return result
	}
	const abortedOutcome = (plan?: Plan) =>
		finish({
			status: budget.reason === 'killed' ? 'killed' : 'failed',
			reason: budget.reason,
			plan,
		})

	await emit({ type: 'started', payload: { budget: job.budget } })
	if (budget.used > 0 || job.budget.maxTokens <= 0) {
		return finish({ status: 'failed', reason: 'budget exceeded' })
	}

	// MARK: Plan
	let plan: Plan
	try {
		plan = await ports.plan({ spec: job.spec, signal, onUsage })
	} catch (error) {
		if (budget.aborted) return abortedOutcome()
		return finish({ status: 'failed', reason: `planning failed: ${(error as Error).message}` })
	}
	if (budget.aborted) return abortedOutcome(plan)
	await emit({ type: 'planned', payload: { plan, tokensUsed: budget.used } })
	await persistTokens()

	// MARK: Build — scheduler loop
	const completed = new Set<string>()
	const failed = new Map<string, string>()
	const running = new Map<string, Promise<void>>()

	// Merges are serialised: one branch into main at a time, in the order tasks finish (which
	// respects the DAG because dependants only start after their dependencies are merged).
	let mergeQueue: Promise<void> = Promise.resolve()

	const mergeFinished = (task: Task, branch: string) =>
		(mergeQueue = mergeQueue.then(async () => {
			if (budget.aborted) return
			let outcome
			try {
				outcome = await ports.mergeTask({
					task,
					branch,
					spec: job.spec,
					repoDir: job.repoDir,
					signal,
					onUsage,
				})
			} catch (error) {
				// A rejection must never poison the queue or escape runJob (finding 1)
				if (budget.aborted) return
				outcome = { ok: false, tokens: 0, reason: (error as Error).message }
			}
			await emit({
				type: 'merge',
				payload: {
					taskId: task.id,
					branch,
					ok: outcome.ok,
					tokens: outcome.tokens,
					reason: outcome.reason,
				},
			})
			if (outcome.ok) completed.add(task.id)
			else failed.set(task.id, outcome.reason ?? 'merge failed')
			await persistTokens()
		}))

	const start = (task: Task) => {
		const startedAt = now()
		const run = (async () => {
			await emit({ type: 'task_started', payload: { taskId: task.id, title: task.title } })
			let outcome
			try {
				outcome = await ports.runTask({
					task,
					spec: job.spec,
					plan,
					repoDir: job.repoDir,
					signal,
					onUsage,
				})
			} catch (error) {
				outcome = {
					ok: false,
					tokens: 0,
					branch: `task/${task.id}`,
					reason: (error as Error).message,
				}
			}
			const durationMs = now() - startedAt
			if (budget.aborted) return
			if (outcome.ok) {
				await emit({
					type: 'task_finished',
					payload: {
						taskId: task.id,
						tokens: outcome.tokens,
						durationMs,
						...(outcome.notes?.length ? { notes: outcome.notes } : {}),
					},
				})
				await mergeFinished(task, outcome.branch)
			} else {
				failed.set(task.id, outcome.reason ?? 'task failed')
				await emit({
					type: 'task_failed',
					payload: { taskId: task.id, tokens: outcome.tokens, durationMs, reason: outcome.reason },
				})
				await persistTokens()
			}
		})().finally(() => running.delete(task.id))
		running.set(task.id, run)
	}

	const isDone = () => {
		const blocked = blockedBy(plan.tasks, new Set(failed.keys()))
		return completed.size + failed.size + blocked.size >= plan.tasks.length && running.size === 0
	}

	while (!isDone() && !budget.aborted) {
		budget.checkDuration()
		const blocked = blockedBy(plan.tasks, new Set(failed.keys()))
		const settled = new Set([...completed, ...failed.keys(), ...blocked])
		const ready = readyTasks(plan.tasks, settled, new Set(running.keys())).filter(
			task =>
				!failed.has(task.id) &&
				!blocked.has(task.id) &&
				task.dependsOn.every(dep => completed.has(dep))
		)
		const slots = job.budget.maxWorkers - running.size
		ready.slice(0, Math.max(0, slots)).forEach(start)
		if (running.size === 0) break
		// Wait for any running task to settle (a task's promise includes its merge)
		await Promise.race([...running.values()])
	}
	await Promise.allSettled([...running.values()])
	await mergeQueue.catch(() => {})

	if (budget.aborted) return abortedOutcome(plan)
	if (failed.size) {
		const blocked = blockedBy(plan.tasks, new Set(failed.keys()))
		const reasons = [...failed].map(([id, reason]) => `${id}: ${reason}`).join('\n')
		const skipped = blocked.size ? `\nnot started (blocked): ${[...blocked].join(', ')}` : ''
		return finish({
			status: 'failed',
			plan,
			reason: `${failed.size} task(s) failed:\n${reasons}${skipped}`,
		})
	}

	// MARK: Gates — verify → acceptance-tests → review → acceptance-check, fail closed
	const gateRun = await runGates({
		spec: job.spec,
		plan,
		repoDir: job.repoDir,
		seedCommit: job.seedCommit,
		waivers: job.gateWaivers ?? [],
		signal,
		onUsage,
		ports,
		emit: hooks.emit,
		isAborted: () => budget.aborted,
		now,
	})
	gates.push(...gateRun.reports)
	await persistTokens()
	if (budget.aborted) return abortedOutcome(plan)
	if (!gateRun.ok) return finish({ status: 'failed', plan, reason: gatesFailedReason(gates) })

	// MARK: Delivery — docs → GitHub repo → App Runner (best effort) → bundle; repo + bundle are the contract
	if (ports.deliver && job.delivery) {
		let delivery
		try {
			delivery = await ports.deliver({
				jobId: job.id,
				spec: job.spec,
				plan,
				gates,
				repoDir: job.repoDir,
				target: job.delivery,
				signal,
				onUsage,
				emit: hooks.emit,
			})
		} catch (error) {
			delivery = { ok: false, tokens: 0, reason: (error as Error).message, steps: [] }
		}
		await persistTokens()
		if (budget.aborted) return abortedOutcome(plan)
		if (!delivery.ok) {
			return finish({ status: 'failed', plan, reason: `delivery failed: ${delivery.reason}` })
		}
		deliverable = delivery.deliverable
	}

	return finish({ status: 'delivered', plan })
}

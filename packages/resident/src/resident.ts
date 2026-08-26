import { rm } from 'node:fs/promises'
import { join } from 'node:path'

import { exec, git, runJob } from '@mf/harness'

import { createAuditLog } from '#/audit.ts'
import { createMonthlyCap } from '#/cap.ts'
import { buildUsageRecord, createUsageMeter, dayOf, usageKey } from '#/metering.ts'
import { branchOf, residentLabels, specFromTask, taskFromInput, taskFromIssue } from '#/tasks.ts'

import type { OrchestratorPorts, TokenUsage } from '@mf/harness'
import type {
	GateReport,
	NewJobEvent,
	NewResidentTask,
	ResidentStatus,
	ResidentTask,
} from '@mf/models'
import type { UsageReporter } from '#/factory.ts'
import type { ResidentGitHub } from '#/github.ts'
import type { ModelPrice } from '#/pricing.ts'
import type { ObjectStore } from '#/store.ts'

export const pausedKey = 'state/paused.json'

/** How the resident gets a working copy for a task and reads what a build changed */
export type Workspace = {
	/** Fresh checkout for the task; returns the repo dir, its default branch and the seed commit */
	prepare: (
		task: ResidentTask,
		signal: AbortSignal
	) => Promise<{ repoDir: string; defaultBranch: string; seedCommit: string }>
	/** Paths changed between the seed commit and the build's `main` */
	changedFiles: (repoDir: string, seedCommit: string) => Promise<string[]>
	/** Creates `branch` at the build's `main` so it can be pushed as the PR head */
	branch: (repoDir: string, branch: string) => Promise<void>
	cleanup: (task: ResidentTask) => Promise<void>
}

export type ResidentOptions = {
	installationId: string
	repository: string
	store: ObjectStore
	github: ResidentGitHub
	ports: OrchestratorPorts
	usageReporter: UsageReporter
	workspace: Workspace
	monthlyTokens: number
	task: { maxTokens: number; maxDurationMinutes: number; maxWorkers: number }
	pausedByEnv?: boolean
	planModel?: string
	workerModel?: string
	prices?: Record<string, ModelPrice>
	/** Kill-switch poll of a running task (default 10 s) */
	killPollMs?: number
	now?: () => number
	log?: (message: string, extra?: Record<string, unknown>) => void
}

const unknownModel = 'unknown'

/**
 * The resident: a queue of tasks (issues labelled `resident`, or `POST /tasks`) built one at a
 * time through the `@mf/harness` orchestrator in a fresh clone, each ending in a pull request.
 * Nothing runs while `paused` or once the month's tokens are spent; every action lands in the
 * audit log before the next one starts; usage is metered per day and reported to the factory.
 */
export const createResident = ({
	installationId,
	repository,
	store,
	github,
	ports,
	usageReporter,
	workspace,
	monthlyTokens,
	task: taskBudget,
	pausedByEnv = false,
	planModel,
	workerModel,
	prices,
	killPollMs = 10_000,
	now = Date.now,
	log = (message, extra) =>
		console.log(JSON.stringify({ time: new Date().toISOString(), message, ...extra })),
}: ResidentOptions) => {
	const audit = createAuditLog({
		store,
		now,
		log: entry => log(`audit ${entry.type}`, { taskId: entry.taskId, ...entry.detail }),
	})
	const cap = createMonthlyCap({ store, maxTokens: monthlyTokens, now })
	const meter = createUsageMeter({ store, now })

	const tasks: ResidentTask[] = []
	const seenIssues = new Set<number>()
	let paused = pausedByEnv
	let running: ResidentTask | undefined
	let capReachedAnnounced = false
	/** Shutdown in progress: no new task, the running one is aborted (not persisted, unlike `paused`) */
	let stopped = false

	const iso = () => new Date(now()).toISOString()
	const queued = () => tasks.filter(task => task.status === 'queued')

	// MARK: Pause

	const persistPaused = () => store.put(pausedKey, JSON.stringify({ paused, changedAt: iso() }))

	const setPaused = async (next: boolean, by: string) => {
		if (paused === next) return paused
		paused = next
		await persistPaused()
		await audit.append(next ? 'paused' : 'resumed', { by, running: running?.id })
		return paused
	}

	// MARK: Queue

	const enqueue = async (task: ResidentTask) => {
		tasks.push(task)
		await audit.append(
			'task_queued',
			{ source: task.source, issueNumber: task.issueNumber, title: task.title },
			task.id
		)
		return task
	}

	/** Issues labelled `resident` that the resident has not touched yet */
	const pollIssues = async () => {
		let issues
		try {
			issues = await github.listIssues(residentLabels.queue)
		} catch (error) {
			log('listing issues failed', { error: (error as Error).message })
			return []
		}
		const fresh = issues.filter(
			issue =>
				!seenIssues.has(issue.number) &&
				!issue.labels.some(label =>
					[residentLabels.running, residentLabels.done, residentLabels.failed].includes(
						label as never
					)
				)
		)
		const added: ResidentTask[] = []
		for (const issue of fresh) {
			seenIssues.add(issue.number)
			added.push(await enqueue(taskFromIssue(issue, now)))
		}
		return added
	}

	// MARK: Build

	const attribute = (model: string | undefined) => model || unknownModel

	/** Ports with usage attributed to a model for the meter (the planner and the workers differ) */
	const meteredPorts = (): OrchestratorPorts => {
		const metered =
			(model: string, onUsage: (usage: TokenUsage) => void) =>
			(usage: TokenUsage): void => {
				void meter.addTokens(model, usage)
				onUsage(usage)
			}
		const plan = (onUsage: (usage: TokenUsage) => void) => metered(attribute(planModel), onUsage)
		const work = (onUsage: (usage: TokenUsage) => void) => metered(attribute(workerModel), onUsage)
		return {
			plan: input => ports.plan({ ...input, onUsage: plan(input.onUsage) }),
			runTask: input => ports.runTask({ ...input, onUsage: work(input.onUsage) }),
			mergeTask: input => ports.mergeTask({ ...input, onUsage: work(input.onUsage) }),
			verify: ports.verify,
			acceptanceTests: input => ports.acceptanceTests({ ...input, onUsage: work(input.onUsage) }),
			review: input => ports.review({ ...input, onUsage: work(input.onUsage) }),
			acceptanceCheck: input => ports.acceptanceCheck({ ...input, onUsage: work(input.onUsage) }),
			// No M5 delivery: the resident delivers as a pull request on the customer's repo
			deliver: undefined,
		}
	}

	/** Every orchestrator event becomes an audit line (the noisy ones summarised) */
	const auditEvent = async (task: ResidentTask, event: NewJobEvent) => {
		const { type, payload } = event
		switch (type) {
			case 'planned': {
				const plan = payload.plan as { summary?: string; tasks?: { id: string; title: string }[] }
				return audit.append(
					'planned',
					{
						summary: plan?.summary,
						steps: plan?.tasks?.map(step => `${step.id}: ${step.title}`),
						tokensUsed: payload.tokensUsed,
					},
					task.id
				)
			}
			case 'task_started':
			case 'task_finished':
			case 'task_failed':
			case 'merge':
				return audit.append('worker', { event: type, ...payload }, task.id)
			case 'gate': {
				const report = payload as unknown as GateReport
				if (report.name === 'verify') {
					await audit.append(
						'command_run',
						{ commands: ['npm run lint', 'npm test'], ok: report.ok, summary: report.summary },
						task.id
					)
				}
				return audit.append(
					'gate',
					{
						name: report.name,
						ok: report.ok,
						tokens: report.tokens,
						durationMs: report.durationMs,
						summary: report.summary,
					},
					task.id
				)
			}
			case 'started':
			case 'done':
			case 'failed':
			case 'killed':
			case 'notify':
			case 'log':
			case 'verify':
			case 'delivery':
				return
		}
	}

	const pullRequestBody = (task: ResidentTask, gates: GateReport[], files: string[]) =>
		[
			task.issueNumber ? `Closes #${task.issueNumber}.` : '',
			'',
			task.description,
			'',
			'## Gates',
			...gates.map(
				gate => `- ${gate.ok ? '✅' : '❌'} ${gate.name}: ${gate.summary.split('\n')[0]}`
			),
			'',
			`## Files (${files.length})`,
			...files.slice(0, 200).map(file => `- \`${file}\``),
			'',
			`_Built by the Mjukvaruhuset resident agent (task ${task.id}, ${task.tokensUsed} tokens)._`,
		].join('\n')

	const finishTask = async (
		task: ResidentTask,
		status: 'done' | 'failed',
		detail: Record<string, unknown>
	) => {
		task.status = status
		task.finishedAt = iso()
		await meter.count(status === 'done' ? 'succeeded' : 'failed')
		await audit.append(status === 'done' ? 'task_finished' : 'task_failed', detail, task.id)
		if (task.issueNumber) {
			await github
				.removeLabel(task.issueNumber, residentLabels.running)
				.then(() =>
					github.addLabels(task.issueNumber!, [
						status === 'done' ? residentLabels.done : residentLabels.failed,
					])
				)
				.catch(error => log('labelling issue failed', { error: (error as Error).message }))
			const text =
				status === 'done'
					? `Pull request opened: ${task.pullRequestUrl}`
					: `The resident could not complete this task: ${task.reason}`
			await github
				.comment(task.issueNumber, text)
				.catch(error => log('commenting failed', { error: (error as Error).message }))
		}
	}

	const build = async (task: ResidentTask) => {
		const remaining = await cap.remaining()
		const maxTokens = Math.min(taskBudget.maxTokens, remaining)
		task.status = 'running'
		running = task
		await meter.count('started')
		await audit.append(
			'task_started',
			{ title: task.title, issueNumber: task.issueNumber, budgetTokens: maxTokens },
			task.id
		)
		if (task.issueNumber) {
			await github
				.addLabels(task.issueNumber, [residentLabels.running])
				.catch(error => log('labelling issue failed', { error: (error as Error).message }))
		}

		let tokensSeen = 0
		const controller = new AbortController()
		try {
			const checkout = await workspace.prepare(task, controller.signal)
			const outcome = await runJob(
				{
					id: task.id,
					spec: specFromTask(task),
					budget: {
						maxTokens,
						maxDurationMinutes: taskBudget.maxDurationMinutes,
						maxWorkers: taskBudget.maxWorkers,
					},
					repoDir: checkout.repoDir,
					seedCommit: checkout.seedCommit,
				},
				{
					ports: meteredPorts(),
					hooks: {
						emit: event => auditEvent(task, event),
						onTokens: async used => {
							const delta = used - tokensSeen
							tokensSeen = used
							task.tokensUsed = used
							if (delta > 0) {
								const reached = await cap.add(delta)
								await audit.append(
									'tokens',
									{ taskTokens: used, monthUsed: await cap.used() },
									task.id
								)
								if (reached) await announceCap()
							}
						},
						// The pause button doubles as the kill switch for the task in flight
						isKilled: async () => paused || stopped,
						pollIntervalMs: killPollMs,
					},
					now,
				}
			)
			task.tokensUsed = outcome.tokensUsed

			if (outcome.status !== 'delivered') {
				task.reason = outcome.reason ?? outcome.status
				await finishTask(task, 'failed', {
					status: outcome.status,
					reason: task.reason,
					tokens: outcome.tokensUsed,
					gates: outcome.gates.map(gate => `${gate.name}:${gate.ok ? 'ok' : 'failed'}`),
				})
				return
			}

			const files = await workspace.changedFiles(checkout.repoDir, checkout.seedCommit)
			await audit.append(
				'files_changed',
				{ count: files.length, files: files.slice(0, 500) },
				task.id
			)
			const branch = branchOf(task)
			await workspace.branch(checkout.repoDir, branch)
			await github.push(checkout.repoDir, branch)
			const pullRequest = await github.createPullRequest({
				head: branch,
				base: checkout.defaultBranch,
				title: task.title,
				body: pullRequestBody(task, outcome.gates, files),
			})
			task.pullRequestUrl = pullRequest.url
			await meter.count('pullRequestsOpened')
			await audit.append(
				'pr_opened',
				{ url: pullRequest.url, number: pullRequest.number, branch, base: checkout.defaultBranch },
				task.id
			)
			await finishTask(task, 'done', {
				tokens: outcome.tokensUsed,
				pullRequestUrl: pullRequest.url,
				files: files.length,
			})
		} catch (error) {
			task.reason = (error as Error).message
			await finishTask(task, 'failed', { reason: task.reason, tokens: task.tokensUsed })
		} finally {
			running = undefined
			await workspace.cleanup(task).catch(() => {})
		}
	}

	const announceCap = async () => {
		if (capReachedAnnounced) return
		capReachedAnnounced = true
		await audit.append('cap_reached', {
			month: await cap.month(),
			usedTokens: await cap.used(),
			maxTokens: monthlyTokens,
		})
	}

	/** Builds the oldest queued task, unless paused, capped, or already building */
	const runNext = async () => {
		if (paused || stopped || running) return undefined
		const [next] = queued()
		if (!next) return undefined
		if (await cap.reached()) {
			await announceCap()
			return undefined
		}
		capReachedAnnounced = false
		await build(next)
		return next
	}

	// MARK: Metering

	/** Writes every touched day's record to the bucket and the factory; keeps the failures for the next round */
	const flushUsage = async () => {
		const used = await cap.used()
		for (const day of meter.days()) {
			const record = buildUsageRecord({
				installationId,
				repository,
				day,
				usage: await meter.read(day),
				monthlyCap: { tokens: monthlyTokens, usedTokens: used },
				prices,
				now,
			})
			await store.put(usageKey(day), JSON.stringify(record, null, '\t'))
			try {
				const response = await usageReporter.report(record)
				if (response) {
					await audit.append('usage_reported', {
						day,
						totalTokens: record.totalTokens,
						billableUsd: record.cost.billableUsd,
					})
				}
			} catch (error) {
				log('reporting usage failed', { day, error: (error as Error).message })
			}
			if (day < dayOf(now() - 24 * 60 * 60_000)) meter.forget(day)
		}
	}

	// MARK: Lifecycle

	const start = async () => {
		const stored = await store.get(pausedKey)
		if (stored) paused = Boolean((JSON.parse(stored) as { paused?: boolean }).paused) || pausedByEnv
		await audit.append('resident_started', {
			repository,
			paused,
			monthlyTokens,
			monthUsed: await cap.used(),
		})
	}

	const status = async (): Promise<ResidentStatus> => {
		const usedTokens = await cap.used()
		return {
			installationId,
			repository,
			paused,
			month: await cap.month(),
			monthlyCap: {
				tokens: monthlyTokens,
				usedTokens,
				remainingTokens: Math.max(0, monthlyTokens - usedTokens),
				reached: usedTokens >= monthlyTokens,
			},
			running: running ? structuredClone(running) : undefined,
			queued: queued().length,
		}
	}

	return {
		start,
		status,
		get paused() {
			return paused
		},
		stop: () => {
			stopped = true
		},
		pause: (by = 'api') => setPaused(true, by),
		resume: (by = 'api') => setPaused(false, by),
		addTask: (input: NewResidentTask) => enqueue(taskFromInput(input, now)),
		tasks: () => structuredClone(tasks),
		pollIssues,
		runNext,
		flushUsage,
		/** One round: pick up issues, build one task, report usage */
		tick: async () => {
			await pollIssues()
			await runNext()
			await flushUsage()
		},
		audit,
		cap,
		meter,
	}
}

export type Resident = ReturnType<typeof createResident>

// MARK: Workspace

/** Clones with the GitHub client into `<workDir>/<task id>/repo`; the seed commit is HEAD after the clone */
export const createGitWorkspace = (workDir: string, github: ResidentGitHub): Workspace => {
	const dirOf = (task: ResidentTask) => join(workDir, task.id)
	return {
		prepare: async (task, signal) => {
			const dir = dirOf(task)
			await rm(dir, { recursive: true, force: true })
			const repoDir = join(dir, 'repo')
			const { defaultBranch } = await github.clone(repoDir, signal)
			// The harness works on `main`; a repo whose default branch is called otherwise gets one
			if (defaultBranch !== 'main') await git(['checkout', '-B', 'main'], { cwd: repoDir, signal })
			const seedCommit = (await git(['rev-parse', 'HEAD'], { cwd: repoDir, signal })).stdout.trim()
			return { repoDir, defaultBranch, seedCommit }
		},
		changedFiles: async (repoDir, seedCommit) => {
			const result = await exec('git', ['diff', '--name-only', `${seedCommit}..main`], {
				cwd: repoDir,
			})
			return result.stdout.split('\n').filter(Boolean)
		},
		branch: async (repoDir, branch) => {
			await git(['branch', '-f', branch, 'main'], { cwd: repoDir })
		},
		cleanup: task => rm(dirOf(task), { recursive: true, force: true }),
	}
}

export type FakeWorkspace = Workspace & { prepared: string[]; cleaned: string[]; files: string[] }

/** No git: a fixed repo dir, a fixed seed commit and whatever `files` the test wants to see changed */
export const createFakeWorkspace = (files = ['src/a.ts']): FakeWorkspace => {
	const fake: FakeWorkspace = {
		prepared: [],
		cleaned: [],
		files,
		prepare: async task => {
			fake.prepared.push(task.id)
			return { repoDir: `/tmp/resident/${task.id}/repo`, defaultBranch: 'main', seedCommit: 'seed' }
		},
		changedFiles: async () => fake.files,
		branch: async () => {},
		cleanup: async task => {
			fake.cleaned.push(task.id)
		},
	}
	return fake
}

import { topologicalOrder } from './dag.ts'
import { exec, git, tail } from './exec.ts'
import { renderSpecForPlanning } from './planner.ts'
import { totalTokens } from './types.ts'
import { repoConventions, runSession } from './worker.ts'

import type { Plan, Spec, Task } from '@mf/models'
import type { MergeOutcome, TokenUsage } from './types.ts'

/** Branch names in the order they are merged into main (dependencies first, plan order within a wave) */
export const mergeOrder = (plan: Plan) =>
	topologicalOrder(plan.tasks).map(task => `task/${task.id}`)

const conflictedFiles = async (repoDir: string, signal: AbortSignal) => {
	const result = await exec('git', ['diff', '--name-only', '--diff-filter=U'], {
		cwd: repoDir,
		signal,
	})
	return result.stdout.trim().split('\n').filter(Boolean)
}

const mergeInProgress = async (repoDir: string) =>
	(await exec('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: repoDir })).code === 0

export const repairSystemPrompt = (spec: Spec, task: Task, files: string[]) =>
	`You are resolving a git merge conflict at Mjukvaruhuset. Branch task/${task.id} ("${task.title}") is being merged into main; both sides are wanted.

Conflicted files:
${files.map(file => `- ${file}`).join('\n')}

Resolve every conflict so that BOTH the existing main behaviour and the task's work are kept, remove all conflict markers, make sure the project still lints and tests (\`npm run lint\`, \`npm test\`), then \`git add\` the resolved files. Do NOT run \`git commit\`, \`git merge --abort\` or change branches — the harness completes the merge.

Task description for context:
${task.description}

The spec:
${renderSpecForPlanning(spec)}

${repoConventions}`

export type MergeTaskInput = {
	task: Task
	branch: string
	spec: Spec
	repoDir: string
	signal: AbortSignal
	onUsage: (usage: TokenUsage) => void
	model?: string
}

/**
 * `git merge --no-ff task/<id>` into main. On conflict, one repair session resolves the files and
 * the merge is committed; if anything is still conflicted the merge is aborted and the job fails
 * closed (a half-merged main is worse than a failed job).
 */
export const mergeTask = async ({
	task,
	branch,
	spec,
	repoDir,
	signal,
	onUsage,
	model,
}: MergeTaskInput): Promise<MergeOutcome> => {
	let tokens = 0
	await git(['checkout', '-q', 'main'], { cwd: repoDir, signal })
	const merge = await exec(
		'git',
		['merge', '--no-ff', '--no-edit', '-m', `merge(${task.id}): ${task.title}`, branch],
		{ cwd: repoDir, signal }
	)
	if (merge.code === 0) return { ok: true, tokens }

	const files = await conflictedFiles(repoDir, signal)
	if (!files.length || !(await mergeInProgress(repoDir))) {
		await exec('git', ['merge', '--abort'], { cwd: repoDir })
		return {
			ok: false,
			tokens,
			reason: `merge of ${branch} failed:\n${tail(merge.stderr || merge.stdout)}`,
		}
	}

	const session = await runSession({
		cwd: repoDir,
		systemPrompt: repairSystemPrompt(spec, task, files),
		prompt: `Resolve the merge conflicts in: ${files.join(', ')}. Then run lint + tests and git add the files.`,
		signal,
		onUsage: usage => {
			tokens += totalTokens(usage)
			onUsage(usage)
		},
		model,
		maxTurns: 60,
	})

	const remaining = signal.aborted ? files : await conflictedFiles(repoDir, signal)
	if (!session.ok || remaining.length) {
		await exec('git', ['merge', '--abort'], { cwd: repoDir })
		const reason = remaining.length
			? `merge of ${branch} still conflicted after repair: ${remaining.join(', ')}`
			: `merge repair session failed: ${session.result}`
		return { ok: false, tokens, reason }
	}

	await exec('git', ['add', '-A'], { cwd: repoDir, signal })
	const commit = await exec(
		'git',
		[
			'-c',
			'core.editor=true',
			'commit',
			'-q',
			'--no-edit',
			'-m',
			`merge(${task.id}): ${task.title} (conflicts resolved)`,
		],
		{ cwd: repoDir, signal }
	)
	if (commit.code !== 0) {
		await exec('git', ['merge', '--abort'], { cwd: repoDir })
		return { ok: false, tokens, reason: `merge commit failed:\n${tail(commit.stderr)}` }
	}
	return { ok: true, tokens }
}

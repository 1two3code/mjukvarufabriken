import { topologicalOrder } from './dag.ts'
import { exec, git, tail } from './exec.ts'
import { renderFencedSpec } from './planner.ts'
import { totalTokens } from './types.ts'
import { ensureShared, repoConventions, runSession } from './worker.ts'

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

/**
 * Files (among the originally conflicted ones) that still contain conflict markers. `git add`
 * clears the unmerged index state regardless of content, so `conflictedFiles` alone is not enough.
 */
const filesWithConflictMarkers = async (repoDir: string, files: string[], signal: AbortSignal) => {
	if (!files.length) return []
	const result = await exec('grep', ['-lE', '^(<{7} |={7}$|>{7} )', '--', ...files], {
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

Resolve every conflict so that BOTH the existing main behaviour and the task's work are kept, remove all conflict markers and make sure the project still lints and tests (\`npm run lint\`, \`npm test\`). Edit the files only — do NOT run \`git add\`, \`git commit\`, \`git merge --abort\` or change branches (the repository index is not yours to write; the harness stages the files and completes the merge).

Task description for context:
${task.description}

${renderFencedSpec(spec)}

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
	if (merge.code === 0) return syncDependencies(repoDir, tokens, signal)

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
		prompt: `Resolve the merge conflicts in: ${files.join(', ')}. Then run lint + tests. Do not stage or commit — the harness does.`,
		signal,
		onUsage: usage => {
			tokens += totalTokens(usage)
			onUsage(usage)
		},
		model,
		maxTurns: 60,
	})

	// The session runs as the worker uid and cannot write main's index (the job's own .git), so
	// the job stages the repaired files itself before checking what is still unmerged
	// (Fargate run 43e7f528, 2026-08-27: six files "still conflicted" that were resolved on disk)
	if (!signal.aborted && session.ok) {
		await exec('git', ['add', '--', ...files], { cwd: repoDir, signal })
	}
	const remaining = signal.aborted
		? files
		: [
				...new Set([
					...(await conflictedFiles(repoDir, signal)),
					...(await filesWithConflictMarkers(repoDir, files, signal)),
				]),
			]
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
	return syncDependencies(repoDir, tokens, signal)
}

/** Manifest files whose change in a merge means main's node_modules is stale */
const manifestPattern = /(^|\/)package(-lock)?\.json$/

/**
 * Workers install packages in their own worktree, so a merge can bring in a `package.json` /
 * lock change that main's hard-linked `node_modules` does not have — the final verify (and every
 * later worktree, which links main's node_modules) would then fail on a missing module. Runs
 * `npm install` on main when the merge commit touched a manifest. Registry access goes through
 * the egress allowlist (registry.npmjs.org).
 */
export const syncDependencies = async (
	repoDir: string,
	tokens: number,
	signal?: AbortSignal
): Promise<MergeOutcome> => {
	const changed = await exec('git', ['diff', '--name-only', 'HEAD~1', 'HEAD'], { cwd: repoDir, signal })
	const manifests = changed.stdout.split('\n').filter(file => manifestPattern.test(file))
	if (!manifests.length) return { ok: true, tokens }
	// Installs whatever the workers added to the manifests. Runs as the job uid: main's
	// node_modules (hard-linked from the template) belongs to the job, so the worker uid cannot
	// replace files in it (npm exited 243 without output on Fargate run 6ff720d2, 2026-08-27).
	// Lifecycle scripts stay off, so no package code runs with the job's privileges; the worktrees
	// re-link the result for the next tasks (`ensureShared`).
	const install = await exec(
		'npm',
		['install', '--no-audit', '--no-fund', '--ignore-scripts', '--loglevel=error'],
		{ cwd: repoDir, signal }
	)
	await ensureShared(repoDir)
	if (install.code !== 0) {
		return {
			ok: false,
			tokens,
			reason: `npm install after merging ${manifests.join(', ')} failed (${install.code}):\n${tail(install.stderr || install.stdout)}`,
		}
	}
	return { ok: true, tokens }
}

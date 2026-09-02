import { topologicalOrder } from './dag.ts'
import { exec, git, tail } from './exec.ts'
import { renderFencedSpec } from './planner.ts'
import { totalTokens } from './types.ts'
import { ensureShared, gatedMainRef, repoConventions, runSession, verifyRepo } from './worker.ts'

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
	// `\|{7}` is the diff3/zdiff3 base marker — inert under the default conflictStyle, but a
	// repair under a repo that sets `merge.conflictStyle=diff3` must not slip it through.
	const result = await exec('grep', ['-lE', '^(<{7} |={7}$|>{7} |\\|{7}( |$))', '--', ...files], {
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
	/** The merge gate (lint + tests on the merged main); defaults to `verifyRepo` — a seam for tests */
	verify?: typeof verifyRepo
}

/**
 * Serialised merges share main's single working tree, so every merge starts from a known-clean,
 * committed state: clear any half-finished merge, drop stray edits and untracked scratch files a
 * previous step left behind (an interrupted repair, an aborted install). `-x` is NOT passed, so
 * ignored files — node_modules — survive.
 */
const resetMain = async (repoDir: string, signal: AbortSignal) => {
	await git(['reset', '--hard', '-q'], { cwd: repoDir, signal })
	await git(['checkout', '-q', '-f', 'main'], { cwd: repoDir, signal })
	await git(['clean', '-qfd'], { cwd: repoDir, signal })
}

/** Puts main back exactly where it was before the merge; best effort (a later `resetMain` re-cleans) */
const rollbackTo = async (repoDir: string, commit: string) => {
	await exec('git', ['reset', '--hard', '-q', commit], { cwd: repoDir })
	await exec('git', ['clean', '-qfd'], { cwd: repoDir })
}

/**
 * `git merge --no-ff task/<id>` into main. On conflict, one repair session resolves the files and
 * the merge is committed; if anything is still conflicted the merge is aborted and the job fails
 * closed (a half-merged main is worse than a failed job).
 *
 * Gate-on-merge: git's exit code proves the merge was TEXTUALLY clean, nothing more, so after
 * every accepted merge (clean or repaired) main is built and tested — scoped to the task's areas,
 * widened to the full repo when the merged diff strays outside them — BEFORE the outcome is
 * reported ok and dependant tasks clone this main. A red gate rolls main back to the pre-merge
 * commit and fails the task. This gates main in place rather than on an integration branch: the
 * orchestrator already serialises merges (one `mergeTask` owns main's tree at a time), so
 * pre-merge-HEAD + `reset --hard` on red gives the same "main is always a gated, buildable tree"
 * invariant without a second working tree, a second node_modules and a fast-forward step.
 *
 * Two things a rollback must not leave behind:
 * - Task CLONES are not serialised with the merge queue (the scheduler starts ready tasks while
 *   another task's merge gate is still running), so while the gate runs, live `main` points at a
 *   commit that may be rolled back. `gatedMainRef` records the last gated commit — written here
 *   before the merge commit and advanced only on green — and `createWorktree` bases every task
 *   branch on it, so no clone can ever capture (and later re-introduce) a rejected merge.
 * - `syncDependencies` mutates main's node_modules BEFORE the gate; `reset --hard` restores the
 *   tree but not node_modules, so a rejected manifest-touching merge would leave every later
 *   gate running against dependency state the shipped lockfile does not declare
 *   (`restoreDependencies` re-installs against the rolled-back lockfile).
 */
export const mergeTask = async ({
	task,
	branch,
	spec,
	repoDir,
	signal,
	onUsage,
	model,
	verify = verifyRepo,
}: MergeTaskInput): Promise<MergeOutcome> => {
	let tokens = 0
	await resetMain(repoDir, signal)
	const preMergeHead = (
		await git(['rev-parse', 'HEAD'], { cwd: repoDir, signal })
	).stdout.trim()
	// Between merges main is always a gated state, so recording it is always correct — and doing
	// it before the merge commit guarantees the ref exists the moment main can first point at an
	// ungated commit (see `gatedMainRef` in worker.ts: task clones base on this ref, not on main)
	await git(['update-ref', gatedMainRef, preMergeHead], { cwd: repoDir, signal })

	// Rolls a rejected merge off main; when its dependency sync already ran npm install, also
	// re-sync node_modules to the rolled-back manifests (a plain reset restores the tree only)
	const reject = async (installed: boolean | undefined, reason: string): Promise<MergeOutcome> => {
		await rollbackTo(repoDir, preMergeHead)
		const restore = installed ? await restoreDependencies(repoDir, preMergeHead, signal) : ''
		return { ok: false, tokens, reason: `${reason}${restore}` }
	}

	// Accepts the merge that is now committed on main: dependency sync, then the merge gate
	const acceptMerge = async (): Promise<MergeOutcome> => {
		const sync = await syncDependencies(repoDir, tokens, signal)
		if (!sync.ok) {
			// Unlike every other failure path this one is past the merge commit — never leave the
			// rejected task's commit in main for the next merge to build on (the failed install
			// may have half-applied, so the restore runs here too)
			return reject(sync.installed, sync.reason ?? 'dependency sync failed')
		}
		const changed = (
			await exec('git', ['diff', '--name-only', `${preMergeHead}..HEAD`], { cwd: repoDir, signal })
		).stdout
			.split('\n')
			.filter(Boolean)
		const verification = await verify(repoDir, signal, { areas: task.areas, changed })
		if (!verification.ok) {
			return reject(
				sync.installed,
				`main is not green after merging ${branch} (rolled back):\n${verification.output}`
			)
		}
		// Green: this main (merge + possible lockfile refresh) is the new base for task clones
		await git(['update-ref', gatedMainRef, 'HEAD'], { cwd: repoDir, signal })
		return { ok: true, tokens }
	}

	const merge = await exec(
		'git',
		['merge', '--no-ff', '--no-edit', '-m', `merge(${task.id}): ${task.title}`, branch],
		{ cwd: repoDir, signal }
	)
	if (merge.code === 0) return acceptMerge()

	const files = await conflictedFiles(repoDir, signal)
	if (!files.length || !(await mergeInProgress(repoDir))) {
		await exec('git', ['merge', '--abort'], { cwd: repoDir })
		return {
			ok: false,
			tokens,
			reason: `merge of ${branch} failed:\n${tail(merge.stderr || merge.stdout)}`,
		}
	}

	/**
	 * A repair can fail in two recoverable ways: leave conflicts unresolved, or "resolve" one by
	 * keeping main's side verbatim and silently discarding the branch's work. Both were previously
	 * terminal for the TASK — and since a task is a whole slice of a paid build, one unlucky
	 * conflict resolution cost the build (dogfood run 5, 2026-09-01).
	 *
	 * Neither is a reason to give up on the first try: the session simply did the wrong thing and
	 * can be told so. Each retry re-creates the conflict from scratch (the previous attempt was
	 * aborted) and states precisely what went wrong, so the model is correcting a named mistake
	 * rather than repeating a guess. Detection is unchanged — a bad repair is still never merged.
	 */
	const maxRepairAttempts = 2
	let priorProblem: string | undefined

	for (let attempt = 1; attempt <= maxRepairAttempts; attempt++) {
		if (signal.aborted) return { ok: false, tokens, reason: 'aborted' }

		const session = await runSession({
			cwd: repoDir,
			systemPrompt: repairSystemPrompt(spec, task, files),
			prompt: priorProblem
				? `Your previous attempt at this merge was REJECTED: ${priorProblem}\n\nResolve the merge conflicts in: ${files.join(', ')} — this time keeping BOTH sides' intent. Every one of these files was changed on both branches, so a correct resolution differs from both. Then run lint + tests. Do not stage or commit — the harness does.`
				: `Resolve the merge conflicts in: ${files.join(', ')}. Then run lint + tests. Do not stage or commit — the harness does.`,
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

		// A repair that "resolves" a conflict by keeping main's side verbatim passes the marker scan
		// and — when the dropped work has no test — the merge gate too, silently shipping without the
		// branch's work. Both sides of a conflicted file changed it, so its resolution must differ
		// from pre-merge main; one that does not means the branch's work in it was discarded.
		const diffedVsMain = new Set(
			remaining.length
				? []
				: (
						await exec('git', ['diff', '--name-only', preMergeHead, '--', ...files], {
							cwd: repoDir,
							signal,
						})
					).stdout
						.split('\n')
						.filter(Boolean)
		)
		const dropped = remaining.length ? [] : files.filter(file => !diffedVsMain.has(file))

		if (session.ok && !remaining.length && !dropped.length) break

		priorProblem = !session.ok
			? `the repair session itself failed: ${session.result}`
			: remaining.length
				? `these files were still conflicted afterwards: ${remaining.join(', ')}`
				: `you kept main's version verbatim of ${dropped.join(', ')}, discarding this branch's work in them`
		const reason = !session.ok
			? `merge repair session failed: ${session.result}`
			: remaining.length
				? `merge of ${branch} still conflicted after repair: ${remaining.join(', ')}`
				: `merge repair of ${branch} discarded the branch's changes (files identical to pre-merge main): ${dropped.join(', ')}`

		await exec('git', ['merge', '--abort'], { cwd: repoDir })
		if (attempt === maxRepairAttempts || signal.aborted) {
			return { ok: false, tokens, reason: `${reason} (after ${attempt} repair attempt(s))` }
		}
		// Re-create the same conflict for the next attempt; the abort above cleared it
		const retryMerge = await exec(
			'git',
			['merge', '--no-ff', '--no-edit', '-m', `merge(${task.id}): ${task.title}`, branch],
			{ cwd: repoDir, signal }
		)
		if (retryMerge.code === 0) return acceptMerge()
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
	return acceptMerge()
}

/** Manifest files whose change in a merge means main's node_modules is stale */
const manifestPattern = /(^|\/)package(-lock)?\.json$/

/** `MergeOutcome` plus whether `npm install` was attempted (i.e. node_modules may have changed) */
type SyncOutcome = MergeOutcome & { installed?: boolean }

/** The npm invocation `syncDependencies` and `restoreDependencies` share (see there for flags) */
const npmInstall = (repoDir: string, signal?: AbortSignal) =>
	exec('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', '--loglevel=error'], {
		cwd: repoDir,
		signal,
	})

/**
 * Re-syncs main's node_modules to the ROLLED-BACK manifests + lockfile after a rejected merge
 * whose `syncDependencies` already ran npm install: `reset --hard` restores the tree but not
 * node_modules, and nothing later re-installs (a later merge only syncs when ITS diff touches a
 * manifest) — so every later merge gate, every worktree hard-linking main's node_modules and the
 * final verify would otherwise run against dependency state the shipped lockfile does not
 * declare (false green on a package only the rejected branch installed, spurious red on one its
 * install pruned). `npm install` against the restored lockfile prunes/reverts; the lockfile
 * churn it may leave is rolled back again so main stays clean and committed. Returns a note to
 * append to the failure reason when the re-install itself fails (later gates then run in a
 * possibly-poisoned environment, but they fail closed).
 */
const restoreDependencies = async (
	repoDir: string,
	preMergeHead: string,
	signal?: AbortSignal
): Promise<string> => {
	const install = await npmInstall(repoDir, signal)
	await ensureShared(repoDir)
	await rollbackTo(repoDir, preMergeHead)
	return install.code === 0
		? ''
		: `\n(re-installing node_modules against the restored lockfile also failed (${install.code}): ${tail(install.stderr || install.stdout)})`
}

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
): Promise<SyncOutcome> => {
	const changed = await exec('git', ['diff', '--name-only', 'HEAD~1', 'HEAD'], { cwd: repoDir, signal })
	const manifests = changed.stdout.split('\n').filter(file => manifestPattern.test(file))
	if (!manifests.length) return { ok: true, tokens }
	// Installs whatever the workers added to the manifests. Runs as the job uid: main's
	// node_modules (hard-linked from the template) belongs to the job, so the worker uid cannot
	// replace files in it (npm exited 243 without output on Fargate run 6ff720d2, 2026-08-27).
	// Lifecycle scripts stay off, so no package code runs with the job's privileges; the worktrees
	// re-link the result for the next tasks (`ensureShared`).
	const install = await npmInstall(repoDir, signal)
	await ensureShared(repoDir)
	if (install.code !== 0) {
		return {
			ok: false,
			tokens,
			installed: true,
			reason: `npm install after merging ${manifests.join(', ')} failed (${install.code}):\n${tail(install.stderr || install.stdout)}`,
		}
	}
	// The install may rewrite the lockfile; commit it, or main's tree is dirty for the next
	// serialised merge (a second lock-touching merge would be refused with "local changes would
	// be overwritten") and the delivered repo ships a lock that is stale against its manifests.
	const status = await exec('git', ['status', '--porcelain'], { cwd: repoDir, signal })
	if (status.stdout.trim()) {
		await exec('git', ['add', '-A'], { cwd: repoDir, signal })
		const commit = await exec(
			'git',
			['commit', '-q', '-m', 'chore(deps): lockfile refreshed by npm install after merge'],
			{ cwd: repoDir, signal }
		)
		if (commit.code !== 0) {
			return {
				ok: false,
				tokens,
				installed: true,
				reason: `lockfile commit failed:\n${tail(commit.stderr)}`,
			}
		}
	}
	return { ok: true, tokens, installed: true }
}

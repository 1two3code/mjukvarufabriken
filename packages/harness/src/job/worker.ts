import { spawn } from 'node:child_process'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'

import { query } from '@anthropic-ai/claude-agent-sdk'

import { exec, git, launch, sandboxEnv, sandboxUser, tail, workerEnv } from './exec.ts'
import { renderSpecForPlanning } from './planner.ts'
import { totalTokens } from './types.ts'
import { createUsageAccumulator } from './usage.ts'

import { sizeClass } from '#spec/priceEstimator.ts'

import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { Plan, SizeClass, Spec, Task } from '@mf/models'
import type { TaskOutcome, TokenUsage, VerifyOutcome } from './types.ts'

// MARK: Model + prompt

export const defaultWorkerModel = 'claude-sonnet-5'
export const resolveWorkerModel = (override?: string) =>
	override || process.env.WORKER_MODEL || defaultWorkerModel

export const repoConventions = `Repository conventions (npm-workspaces TypeScript monorepo, ESM):
- Run every command from the repository root: \`npm run lint\`, \`npm test\`, \`npm run build\`.
- Imports use the \`.ts\` extension and the workspace's \`#/*\` alias; no relative parent imports (\`../\`).
- Named exports everywhere except Fastify plugins/routes/services (default export for autoload).
- Zod 4 schemas live in packages/models; the api validates with fastify-type-provider-zod and every route needs a response schema.
- React 19 with the React Compiler: no useMemo/useCallback/React.memo. CSS modules, design tokens as CSS custom properties. User-facing text goes through useTranslation(); add every key to public/locales/en.json AND sv.json.
- Prettier: tabs, no semicolons, single quotes, 100 columns. Do not hand-format imports.
- Network: only the npm registry, GitHub and the Anthropic API are reachable (egress allowlist); every other network call fails, so do not try other hosts or the cloud metadata/credential endpoints.
- Read CLAUDE.md and the matching .claude/rules/*.instructions.md before editing an area.
- Commit your work with git when done (\`git add -A && git commit -m "feat(<area>): <task title>"\`). Never push, never change branches, never touch files outside this working directory.`

/**
 * Efficiency knobs (docs/EFFICIENCY.md). Every one is a plain constant so a live job can be
 * measured with a single edit; the numbers are estimates until the next dogfood run.
 */
export const workerLimits = {
	/**
	 * Gate a task on the `apps/*` workspaces in `task.areas` instead of the whole monorepo, as long
	 * as the task's diff stays inside them (`gateScopeForChanges`); a change under `packages/*` is
	 * consumed by every app, so those tasks (and any task that strays) keep the full gate. The
	 * full-repo gate always runs at merge/verify.
	 */
	scopedTaskGate: true,
	/** Turn cap of the implementation session per spec size class */
	maxTurnsBySize: { S: 60, M: 100, L: 150 } satisfies Record<SizeClass, number>,
	/** Turn cap of the one repair session — the safety valve when the cap above cut the worker off */
	repairTurns: 60,
	/** `verifyRepo` shows the worker at most this many lines of a failing gate */
	gateOutputLines: 80,
}

/**
 * The short form for workers: what a task needs to not break the repo. The long template
 * CLAUDE.md is a "read if needed" pointer — every worker turn re-reads its whole context, so
 * a 14 kB conventions dump costs ~4k tokens per turn for the whole session.
 */
export const taskConventions = `Repository conventions (npm-workspaces TypeScript monorepo, ESM):
- Imports use the \`.ts\` extension and the workspace's \`#/*\` alias; no relative parent imports (\`../\`).
- Named exports everywhere except Fastify plugins/routes/services (default export for autoload).
- Zod 4 schemas live in packages/models; every api route needs a response schema.
- React 19 with the React Compiler: no useMemo/useCallback/React.memo. CSS modules. User-facing text goes through useTranslation(); add every key to public/locales/en.json AND sv.json.
- Prettier: tabs, no semicolons, single quotes, 100 columns. Do not hand-format imports.
- Network: only the npm registry, GitHub and the Anthropic API are reachable (egress allowlist); every other network call fails, so do not try other hosts or the cloud metadata/credential endpoints.
- CLAUDE.md and .claude/rules/*.instructions.md hold the full conventions — read only the rule file that matches the area you edit, and only when the notes above are not enough.
- Commit with git when done (\`git add -A && git commit -m "feat(<area>): <task title>"\`). Never push, never change branches, never touch files outside this working directory.`

/** Which workspaces a task's gate covers; `full` = the repo-root `npm run lint` + `npm test` */
export type GateScope = { workspaces: string[] } | { full: true }

const workspaceOf = (area: string) =>
	area
		.replace(/^\.?\//, '')
		.split('/')
		.slice(0, 2)
		.join('/')

/**
 * Pure mapping from a task's `areas` to the gate scope: `apps/<x>` (or anything below it) →
 * that workspace; anything else (packages, infra, root files, unknown) → full gate.
 */
export const gateScopeForAreas = (areas: string[]): GateScope => {
	if (!workerLimits.scopedTaskGate || !areas.length) return { full: true }
	const workspaces = new Set<string>()
	for (const area of areas) {
		const workspace = workspaceOf(area)
		if (!/^apps\/[\w.-]+$/.test(workspace)) return { full: true }
		workspaces.add(workspace)
	}
	return { workspaces: [...workspaces].sort() }
}

/**
 * The scope the gate actually runs: the planner's `areas` are a hint, the files the worker
 * changed decide. Any changed path outside the scoped `apps/*` workspaces (a schema in
 * packages/models, the root vitest config, …) widens the gate to the full repo, because that is
 * the only gate that sees the other consumers of the change.
 */
export const gateScopeForChanges = (areas: string[], changedFiles: string[]): GateScope => {
	const scope = gateScopeForAreas(areas)
	if ('full' in scope) return scope
	const outside = changedFiles.filter(file => !scope.workspaces.includes(workspaceOf(file)))
	return outside.length ? { full: true } : scope
}

/** Files a task branch changed against main (committed; call after `commitLeftovers`) */
export const changedFiles = async (dir: string, signal?: AbortSignal) => {
	const result = await exec('git', ['diff', '--name-only', 'main...HEAD'], { cwd: dir, signal })
	return result.stdout.split('\n').filter(Boolean)
}

export type GateCommand = { script: 'lint' | 'test'; command: string; args: string[] }

/** The commands the gate runs (and tells the worker to run) for a scope */
export const gateCommands = (scope: GateScope): GateCommand[] =>
	'full' in scope
		? [
				{ script: 'lint', command: 'npm', args: ['run', 'lint', '--silent'] },
				{ script: 'test', command: 'npm', args: ['run', 'test', '--silent'] },
			]
		: [
				{
					script: 'lint',
					command: 'npm',
					args: [
						'run',
						'lint',
						'--silent',
						'--if-present',
						...scope.workspaces.flatMap(ws => ['-w', ws]),
					],
				},
				{
					script: 'test',
					command: 'npx',
					args: ['vitest', 'run', '--passWithNoTests', ...scope.workspaces],
				},
			]

export const renderCommand = ({ command, args }: Pick<GateCommand, 'command' | 'args'>) =>
	[command, ...args.filter(arg => arg !== '--silent')].join(' ')

export const workerSystemPrompt = (
	spec: Spec,
	plan: Plan,
	task: Task,
	scope: GateScope = gateScopeForAreas(task.areas)
) => {
	const [lint, test] = gateCommands(scope).map(renderCommand)
	const scopeNote =
		'full' in scope
			? 'the whole repository'
			: `the workspace(s) you touch (${scope.workspaces.join(', ')}); the full repository is checked again after merge`
	return `You are an autonomous software engineer at Mjukvaruhuset building a customer application from a frozen spec. You work in an isolated git worktree on branch task/${task.id}; other workers handle the other tasks in parallel and your branches are merged afterwards in dependency order.

# Your task: ${task.title}
${task.description}

Areas: ${task.areas.join(', ') || '-'}
Acceptance criteria this task satisfies: ${task.acceptanceCriteriaIds.join(', ') || '-'}
Depends on (already merged into your branch): ${task.dependsOn.join(', ') || 'nothing'}

# Definition of done
1. The task description is implemented and the listed acceptance criteria are met.
2. The gate is green for ${scopeNote}: \`${lint}\` and \`${test}\` from the repository root.
3. The work is committed on the current branch.
Stay within your task: do not implement the other tasks in the plan, but keep interfaces compatible with them.

# Working efficiently (every turn re-reads your whole context; keep it small)
- Read only the files you need; do not read CLAUDE.md or the rules up front.
- While iterating, type-check with \`npx tsgo --noemit -p <workspace>\` (seconds) instead of the full lint.
- Run the lint + test gate at most twice: once when the implementation is complete, once after fixing what it reported. Never run the full-repo \`npm run lint\`/\`npm test\` when the scoped commands above cover your change.
- Batch independent shell commands and edits; do not re-run passing tests.

# The whole plan (for context)
${plan.summary}
${plan.tasks.map(item => `- ${item.id}: ${item.title}${item.id === task.id ? ' (YOU)' : ''}`).join('\n')}

# The spec
${renderSpecForPlanning(spec)}

# ${taskConventions}`
}

/** Implementation-session turn cap for a spec (`sizeClass` from the price estimate when unset) */
export const maxTurnsForSpec = (spec: Spec) => {
	const size = spec.sizeClass ?? sizeClass(spec)
	return { size, maxTurns: workerLimits.maxTurnsBySize[size] }
}

// MARK: Worktrees

export const worktreeDir = (repoDir: string, taskId: string) =>
	join(dirname(repoDir), 'worktrees', taskId)

const findNodeModules = async (root: string): Promise<string[]> => {
	const found: string[] = []
	const walk = async (dir: string, depth: number) => {
		if (depth > 3) return
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue
			const full = join(dir, entry.name)
			if (entry.name === 'node_modules') found.push(full)
			else if (!entry.name.startsWith('.')) await walk(full, depth + 1)
		}
	}
	await walk(root, 0)
	return found
}

/**
 * Hard-links every `node_modules` of the main checkout into the worktree so workers never need
 * the network to install. Workspace symlinks are relative, so they resolve inside the worktree.
 */
export const shareNodeModules = async (repoDir: string, targetDir: string) => {
	for (const source of await findNodeModules(repoDir)) {
		const target = join(targetDir, relative(repoDir, source))
		if (await exists(target)) continue
		await mkdir(dirname(target), { recursive: true })
		await exec('cp', ['-al', source, target], { cwd: repoDir })
	}
}

/**
 * Makes a directory writable for the worker uid (`sandboxUser`): the job and the workers are
 * different users in one group, `/work` carries the setgid bit so everything below it is
 * group-owned, and this puts the group write bit on what was created with a stricter mode (the
 * template copy, `cp -al` — which also re-applies the source group — and anything git checked
 * out before `umask 002` took effect). Hard-linked `node_modules` files are shared inodes, so
 * their mode changes for every worktree at once — same as before, when everything was one uid.
 * A no-op without a sandbox user.
 */
export const shareWithWorker = async (dir: string) => {
	if (!sandboxUser()) return
	const { gid } = await stat(dir)
	await exec('chgrp', ['-R', String(gid), dir], { cwd: dir })
	await exec('chmod', ['-R', 'g+rwX', dir], { cwd: dir })
	shared.add(dir)
}

const shared = new Set<string>()

/** `shareWithWorker` once per directory and process — before the first worker runs in it */
export const ensureShared = async (dir: string) => {
	if (!shared.has(dir)) await shareWithWorker(dir)
}

/** `git worktree add -b task/<id>` from the current main, with node_modules shared */
export const createWorktree = async (repoDir: string, task: Task, signal?: AbortSignal) => {
	const dir = worktreeDir(repoDir, task.id)
	const branch = `task/${task.id}`
	await rm(dir, { recursive: true, force: true })
	await exec('git', ['branch', '-D', branch], { cwd: repoDir, signal })
	await git(['worktree', 'prune'], { cwd: repoDir, signal })
	await git(['worktree', 'add', '-b', branch, dir, 'main'], { cwd: repoDir, signal })
	await shareNodeModules(repoDir, dir)
	await shareWithWorker(dir)
	return { dir, branch }
}

export const removeWorktree = async (repoDir: string, taskId: string) => {
	const dir = worktreeDir(repoDir, taskId)
	await exec('git', ['worktree', 'remove', '--force', dir], { cwd: repoDir })
	await rm(dir, { recursive: true, force: true })
}

// MARK: Verification

export type VerifyOptions = {
	/** Task areas → scoped gate (see `gateScopeForAreas`); omitted → full-repo gate */
	areas?: string[]
	/** Files the task changed; any path outside the scoped workspaces widens to the full gate */
	changed?: string[]
}

const testFilePattern = /\.(test|spec)\.[cm]?[jt]sx?$/
const skippedDirs = new Set(['node_modules', 'dist', 'coverage', '.git'])

/** True when a directory holds at least one test file (outside node_modules/dist) */
export const hasTestFiles = async (dir: string): Promise<boolean> => {
	if (!(await exists(dir))) return false
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (!skippedDirs.has(entry.name) && (await hasTestFiles(join(dir, entry.name)))) return true
		} else if (testFilePattern.test(entry.name)) return true
	}
	return false
}

const noTestFilesMarker = 'No test files found'

/**
 * Runs the customer repo's lint + tests; the gate every task and the final merge must pass.
 * With `areas` the gate is scoped to the task's workspaces (`workerLimits.scopedTaskGate`),
 * widened to the full repo when `changed` names a file outside them. A scoped Vitest run that
 * collected nothing (`--passWithNoTests`) is red when the workspace does hold test files — they
 * exist but no Vitest project picks them up, so a green exit would be vacuous.
 */
export const verifyRepo = async (
	repoDir: string,
	signal?: AbortSignal,
	{ areas, changed = [] }: VerifyOptions = {}
): Promise<VerifyOutcome> => {
	const scope: GateScope = areas ? gateScopeForChanges(areas, changed) : { full: true }
	const outputs: string[] = []
	await ensureShared(repoDir)
	for (const step of gateCommands(scope)) {
		// The repo's own scripts are customer code: they run as the worker uid
		const result = await exec(step.command, step.args, { cwd: repoDir, signal, asWorker: true })
		const output = `${result.stdout}\n${result.stderr}`
		if (result.code !== 0) {
			return {
				ok: false,
				output: `${renderCommand(step)} failed (${result.code}):\n${tail(output, workerLimits.gateOutputLines)}`,
			}
		}
		if (step.script === 'test' && 'workspaces' in scope && output.includes(noTestFilesMarker)) {
			const orphans: string[] = []
			for (const workspace of scope.workspaces) {
				if (await hasTestFiles(join(repoDir, workspace))) orphans.push(workspace)
			}
			if (orphans.length) {
				return {
					ok: false,
					output: `${renderCommand(step)} ran no tests, but ${orphans.join(', ')} contains test files that no Vitest project picks up. Add the workspace (with its own vitest config) to \`projects\` in the root vitest.config.ts so they run.`,
				}
			}
			outputs.push(`${renderCommand(step)}: ok (no test files in ${scope.workspaces.join(', ')})`)
			continue
		}
		outputs.push(`${renderCommand(step)}: ok`)
	}
	return { ok: true, output: outputs.join('\n') }
}

/** One test file of a Vitest `--reporter=json` run */
export type VitestFileResult = {
	name: string
	status: string
	assertionResults?: { fullName?: string; title?: string; status: string }[]
}
export type VitestReport = { success?: boolean; testResults?: VitestFileResult[] }

/**
 * Pure verdict on a Vitest JSON report: every acceptance file must appear, hold at least one
 * test, and have nothing but passing tests — a file the runner never picked up (not part of any
 * project, no `test` script) or an empty file is red, never a vacuous pass.
 */
export const evaluateVitestReport = (report: VitestReport, files: string[]): VerifyOutcome => {
	const results = report.testResults ?? []
	const problems: string[] = []
	for (const file of files) {
		const result = results.find(entry => entry.name === file || entry.name.endsWith(`/${file}`))
		if (!result) {
			problems.push(`${file}: not executed`)
			continue
		}
		const tests = result.assertionResults ?? []
		const failed = tests.filter(test => test.status !== 'passed')
		if (!tests.length) problems.push(`${file}: no tests`)
		else if (result.status !== 'passed' || failed.length) {
			problems.push(
				`${file}: ${failed.map(test => `${test.fullName ?? test.title ?? '?'} ${test.status}`).join(', ') || result.status}`
			)
		}
	}
	if (problems.length) {
		return { ok: false, output: `acceptance tests not green:\n${problems.join('\n')}` }
	}
	return { ok: true, output: `${files.length} acceptance test file(s) executed and green` }
}

const jsonFromOutput = (stdout: string): VitestReport | undefined => {
	const start = stdout.indexOf('{')
	if (start < 0) return undefined
	try {
		return JSON.parse(stdout.slice(start)) as VitestReport
	} catch {
		return undefined
	}
}

/**
 * Runs exactly the given acceptance test files through the repo's Vitest (root config, so a
 * file outside every configured project is "not executed") and checks each one passed.
 */
export const runAcceptanceTests = async (
	repoDir: string,
	files: string[],
	signal?: AbortSignal
): Promise<VerifyOutcome> => {
	if (!files.length) return { ok: false, output: 'no acceptance test files to run' }
	await ensureShared(repoDir)
	const result = await exec('npx', ['vitest', 'run', '--reporter=json', '--', ...files], {
		cwd: repoDir,
		signal,
		asWorker: true,
	})
	const report = jsonFromOutput(result.stdout)
	if (!report) {
		return {
			ok: false,
			output: `vitest produced no JSON report (${result.code}):\n${tail(`${result.stdout}\n${result.stderr}`, 40)}`,
		}
	}
	return evaluateVitestReport(report, files)
}

// MARK: Agent session

export const workerTools = ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'] as const
/** Tools of a session that must not change the repo (review, acceptance check) */
export const readOnlyTools = ['Read', 'Glob', 'Grep', 'Bash'] as const

export type SessionInput = {
	cwd: string
	systemPrompt: string
	prompt: string
	signal: AbortSignal
	onUsage: (usage: TokenUsage) => void
	model?: string
	maxTurns?: number
	/** Reasoning effort (default: the model's; `WORKER_EFFORT` env overrides, see docs/EFFICIENCY.md) */
	effort?: Options['effort']
	/** Tool allowlist (default: the full worker set) */
	tools?: readonly string[]
	/** JSON schema the session's final answer must match; parsed into `structuredOutput` */
	outputSchema?: Record<string, unknown>
}

export type SessionOutcome = {
	ok: boolean
	tokens: number
	result: string
	/** True when the session ended because it hit `maxTurns` (the `error_max_turns` result) */
	maxTurnsReached?: boolean
	/** The structured answer when `outputSchema` was given and the session produced one */
	structuredOutput?: unknown
}

const effortLevels = ['low', 'medium', 'high', 'xhigh', 'max'] as const
/** Session effort: explicit > `WORKER_EFFORT` env (one of the SDK levels) > model default */
export const resolveEffort = (
	override?: Options['effort'],
	env: NodeJS.ProcessEnv = process.env
): Options['effort'] => {
	if (override) return override
	const fromEnv = env.WORKER_EFFORT
	return (effortLevels as readonly string[]).includes(fromEnv ?? '')
		? (fromEnv as Options['effort'])
		: undefined
}

/**
 * Environment of an agent session: the sandbox env with every `DISABLE_PROMPT_CACHING*` switch
 * removed, plus the worker uid's HOME / Claude config dir when a sandbox user is configured
 * (the Claude Code process runs as that uid and needs a writable state dir of its own). The
 * Agent SDK marks the system prompt, tool definitions and conversation prefix with
 * `cache_control` by itself, so a stable system prompt is what makes turn N+1 read turn N from
 * cache at 10 % — an inherited kill switch would silently multiply the input cost by ten.
 */
export const sessionEnv = (
	env: NodeJS.ProcessEnv = process.env,
	user = sandboxUser(env)
): NodeJS.ProcessEnv => ({
	...Object.fromEntries(
		Object.entries(sandboxEnv(env)).filter(([key]) => !key.startsWith('DISABLE_PROMPT_CACHING'))
	),
	...workerEnv(user),
	CLAUDE_AGENT_SDK_CLIENT_APP: 'mf-harness/0.1',
})

/**
 * Spawns the Agent SDK's Claude Code process as the sandbox worker uid (`launch` → `setpriv`).
 * The SDK's default spawner is a plain local `spawn`; this one only changes who the process
 * runs as. stderr is inherited so the CLI's own diagnostics reach the job log.
 */
export const spawnWorkerProcess: NonNullable<Options['spawnClaudeCodeProcess']> = ({
	command,
	args,
	cwd,
	env,
	signal,
}) => {
	const launched = launch(command, args, { asWorker: true })
	return spawn(launched.command, launched.args, {
		cwd,
		env,
		signal,
		stdio: ['pipe', 'pipe', 'inherit'],
	})
}

const messageUsage = (message: SDKMessage): TokenUsage | undefined => {
	if (message.type !== 'assistant') return undefined
	const { usage } = message.message
	if (!usage) return undefined
	return {
		inputTokens: usage.input_tokens ?? 0,
		outputTokens: usage.output_tokens ?? 0,
		cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
		cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
	}
}

/**
 * One Claude Agent SDK `query()` session, confined to `cwd`, non-interactive
 * (`bypassPermissions` — the container is the sandbox; there is nobody to ask) and limited to the
 * file + shell tools. Usage is streamed to `onUsage` per assistant message so the budget can abort
 * mid-session; the final result's `modelUsage` (which also covers subagents/compaction) tops up
 * the count.
 */
export const runSession = async ({
	cwd,
	systemPrompt,
	prompt,
	signal,
	onUsage,
	model,
	maxTurns = 200,
	effort,
	tools = workerTools,
	outputSchema,
}: SessionInput): Promise<SessionOutcome> => {
	const controller = new AbortController()
	const onAbort = () => controller.abort(signal.reason)
	if (signal.aborted) onAbort()
	else signal.addEventListener('abort', onAbort, { once: true })

	const resolvedEffort = resolveEffort(effort)
	const options: Options = {
		cwd,
		model: resolveWorkerModel(model),
		...(resolvedEffort ? { effort: resolvedEffort } : {}),
		systemPrompt,
		tools: [...tools],
		allowedTools: [...tools],
		...(outputSchema
			? { outputFormat: { type: 'json_schema' as const, schema: outputSchema } }
			: {}),
		permissionMode: 'bypassPermissions',
		allowDangerouslySkipPermissions: true,
		settingSources: [],
		persistSession: false,
		maxTurns,
		abortController: controller,
		env: sessionEnv(),
		...(sandboxUser() ? { spawnClaudeCodeProcess: spawnWorkerProcess } : {}),
	}
	await ensureShared(cwd)

	const usage = createUsageAccumulator(onUsage)
	let ok = false
	let result = ''
	let structuredOutput: unknown
	let maxTurnsReached = false
	let reported = 0
	let turns = 0
	try {
		for await (const message of query({ prompt, options })) {
			const messageUsageValue = messageUsage(message)
			if (messageUsageValue && message.type === 'assistant') {
				const delta = usage.add(message.message.id, messageUsageValue)
				if (delta > 0) turns += 1
			}
			if (message.type === 'result') {
				reported = Object.values(message.modelUsage ?? {}).reduce(
					(sum, entry) => sum + totalTokens(entry),
					0
				)
				ok = message.subtype === 'success' && !message.is_error
				maxTurnsReached = message.subtype === 'error_max_turns'
				if (message.subtype === 'success') structuredOutput = message.structured_output
				result =
					message.subtype === 'success'
						? message.result
						: `${message.subtype}: ${message.errors.join('; ')}`
				console.log(
					JSON.stringify({
						message: 'session result',
						subtype: message.subtype,
						turns: message.num_turns,
						assistantMessages: turns,
						streamedTokens: usage.total,
						reportedTokens: reported,
						costUsd: message.total_cost_usd,
					})
				)
			}
		}
	} finally {
		signal.removeEventListener('abort', onAbort)
	}
	// Top up with anything the per-message stream missed (subagents, compaction)
	usage.reconcile(reported)
	return { ok, tokens: usage.total, result, maxTurnsReached, structuredOutput }
}

// MARK: Task runner

/** The session and gate `runTask` uses; swapped for fakes in tests */
export type TaskPorts = {
	runSession: typeof runSession
	verifyRepo: typeof verifyRepo
}

export type RunTaskInput = {
	task: Task
	spec: Spec
	plan: Plan
	repoDir: string
	signal: AbortSignal
	onUsage: (usage: TokenUsage) => void
	model?: string
	ports?: Partial<TaskPorts>
}

const hasCommits = async (dir: string, branch: string, signal: AbortSignal) => {
	const result = await exec('git', ['rev-list', '--count', `main..${branch}`], { cwd: dir, signal })
	return result.code === 0 && Number(result.stdout.trim()) > 0
}

/** Commit whatever the agent left uncommitted so the branch is complete */
const commitLeftovers = async (dir: string, task: Task, signal: AbortSignal) => {
	await exec('git', ['add', '-A'], { cwd: dir, signal })
	await exec('git', ['commit', '-q', '-m', `chore(${task.id}): ${task.title} (auto-commit)`], {
		cwd: dir,
		signal,
	})
}

/**
 * One task = one worktree + one agent session (turn cap by spec size), then the lint + test gate
 * scoped to the workspaces the worker actually changed. A second session — at most one — follows
 * when the gate is red (with the output) or when the first session was cut off by its cap (to
 * finish the task); still red afterwards → the task fails. Every cap hit is recorded in the
 * outcome's `notes` (and in the `task_failed` reason), whether or not the task ends green.
 */
export const runTask = async ({
	task,
	spec,
	plan,
	repoDir,
	signal,
	onUsage,
	model,
	ports = {},
}: RunTaskInput): Promise<TaskOutcome> => {
	const session = ports.runSession ?? runSession
	const verify = ports.verifyRepo ?? verifyRepo
	const { dir, branch } = await createWorktree(repoDir, task, signal)
	let tokens = 0
	const count = (usage: TokenUsage) => {
		tokens += totalTokens(usage)
		onUsage(usage)
	}
	const plannedScope = gateScopeForAreas(task.areas)
	const [lint, test] = gateCommands(plannedScope).map(renderCommand)
	const systemPrompt = workerSystemPrompt(spec, plan, task, plannedScope)
	const { size, maxTurns } = maxTurnsForSpec(spec)
	const notes: string[] = []
	const noteCap = (outcome: SessionOutcome, label: string, cap: number) => {
		if (!outcome.maxTurnsReached) return
		notes.push(`${label} hit its turn cap (${cap} turns for size ${size})`)
		console.log(
			JSON.stringify({ message: 'turn cap reached', taskId: task.id, session: label, cap, size })
		)
	}
	const withNotes = (reason: string) => (notes.length ? `${reason} (${notes.join('; ')})` : reason)
	const gate = async () => {
		const changed = await changedFiles(dir, signal)
		const scope = gateScopeForChanges(task.areas, changed)
		if ('full' in scope && !('full' in plannedScope)) {
			notes.push('gate widened to the full repository (changes outside the task workspaces)')
		}
		const commands = gateCommands(scope).map(renderCommand)
		return { verification: await verify(dir, signal, { areas: task.areas, changed }), commands }
	}

	const first = await session({
		cwd: dir,
		systemPrompt,
		prompt: `Implement the task "${task.title}" as described in your instructions. Work through the task, run the gate (\`${lint}\`, \`${test}\`), fix, and commit.`,
		signal,
		onUsage: count,
		model,
		maxTurns,
	})
	if (signal.aborted) return { ok: false, tokens, branch, reason: 'aborted' }
	if (!first.ok && !first.maxTurnsReached) {
		return { ok: false, tokens, branch, reason: `agent session failed: ${first.result}` }
	}
	noteCap(first, 'worker session', maxTurns)

	// A capped session is not a failure yet: whatever it left is committed and gated, and the
	// second session is the safety valve that finishes the last mile.
	await commitLeftovers(dir, task, signal)
	const gated = await gate()
	let { verification } = gated
	const { commands } = gated
	if (!verification.ok || first.maxTurnsReached) {
		const [scopedLint, scopedTest] = commands
		const prompt = verification.ok
			? `Your previous session was cut off by its turn cap (${maxTurns} turns for size ${size}) and its work was committed; the gate (\`${scopedLint}\`, \`${scopedTest}\`) is green. Check the task against its description and acceptance criteria, finish whatever is missing, run the gate once, and commit.`
			: `Verification failed after your work${first.maxTurnsReached ? ` (your session hit its turn cap: ${maxTurns} turns for size ${size})` : ''}. Fix it so that \`${scopedLint}\` and \`${scopedTest}\` pass, then commit. Run the gate at most once more after your fixes.\n\n${verification.output}`
		const repair = await session({
			cwd: dir,
			systemPrompt,
			prompt,
			signal,
			onUsage: count,
			model,
			maxTurns: workerLimits.repairTurns,
		})
		if (signal.aborted) return { ok: false, tokens, branch, reason: 'aborted' }
		if (!repair.ok && !repair.maxTurnsReached) {
			return {
				ok: false,
				tokens,
				branch,
				reason: withNotes(`repair session failed: ${repair.result}`),
			}
		}
		noteCap(repair, 'repair session', workerLimits.repairTurns)
		await commitLeftovers(dir, task, signal)
		;({ verification } = await gate())
		if (!verification.ok) {
			return { ok: false, tokens, branch, reason: withNotes(verification.output) }
		}
	}
	if (!(await hasCommits(dir, branch, signal))) {
		return { ok: false, tokens, branch, reason: withNotes('worker produced no commits') }
	}
	return { ok: true, tokens, branch, ...(notes.length ? { notes } : {}) }
}

/** True when the directory exists (used by callers that clean up worktrees defensively) */
export const exists = async (path: string) =>
	stat(path).then(
		() => true,
		() => false
	)

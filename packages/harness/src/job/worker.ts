import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'

import { query } from '@anthropic-ai/claude-agent-sdk'

import { exec, git, sandboxEnv, tail } from './exec.ts'
import { renderSpecForPlanning } from './planner.ts'
import { totalTokens } from './types.ts'
import { createUsageAccumulator } from './usage.ts'

import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { Plan, Spec, Task } from '@mf/models'
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
- Read CLAUDE.md and the matching .claude/rules/*.instructions.md before editing an area.
- Commit your work with git when done (\`git add -A && git commit -m "feat(<area>): <task title>"\`). Never push, never change branches, never touch files outside this working directory.`

export const workerSystemPrompt = (spec: Spec, plan: Plan, task: Task) =>
	`You are an autonomous software engineer at Mjukvaruhuset building a customer application from a frozen spec. You work in an isolated git worktree on branch task/${task.id}; other workers handle the other tasks in parallel and your branches are merged afterwards in dependency order.

# Your task: ${task.title}
${task.description}

Areas: ${task.areas.join(', ') || '-'}
Acceptance criteria this task satisfies: ${task.acceptanceCriteriaIds.join(', ') || '-'}
Depends on (already merged into your branch): ${task.dependsOn.join(', ') || 'nothing'}

# Definition of done
1. The task description is implemented and the listed acceptance criteria are met.
2. \`npm run lint\` and \`npm test\` pass from the repository root — run them yourself and fix everything they report before you finish.
3. The work is committed on the current branch.
Stay within your task: do not implement the other tasks in the plan, but keep interfaces compatible with them.

# The whole plan (for context)
${plan.summary}
${plan.tasks.map(item => `- ${item.id}: ${item.title}${item.id === task.id ? ' (YOU)' : ''}`).join('\n')}

# The spec
${renderSpecForPlanning(spec)}

# ${repoConventions}`

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

/** `git worktree add -b task/<id>` from the current main, with node_modules shared */
export const createWorktree = async (repoDir: string, task: Task, signal?: AbortSignal) => {
	const dir = worktreeDir(repoDir, task.id)
	const branch = `task/${task.id}`
	await rm(dir, { recursive: true, force: true })
	await exec('git', ['branch', '-D', branch], { cwd: repoDir, signal })
	await git(['worktree', 'prune'], { cwd: repoDir, signal })
	await git(['worktree', 'add', '-b', branch, dir, 'main'], { cwd: repoDir, signal })
	await shareNodeModules(repoDir, dir)
	return { dir, branch }
}

export const removeWorktree = async (repoDir: string, taskId: string) => {
	const dir = worktreeDir(repoDir, taskId)
	await exec('git', ['worktree', 'remove', '--force', dir], { cwd: repoDir })
	await rm(dir, { recursive: true, force: true })
}

// MARK: Verification

/** Runs the customer repo's lint + tests; the gate every task and the final merge must pass */
export const verifyRepo = async (repoDir: string, signal?: AbortSignal): Promise<VerifyOutcome> => {
	const outputs: string[] = []
	for (const script of ['lint', 'test']) {
		const result = await exec('npm', ['run', script, '--silent'], { cwd: repoDir, signal })
		const output = `${result.stdout}\n${result.stderr}`
		if (result.code !== 0) {
			return {
				ok: false,
				output: `npm run ${script} failed (${result.code}):\n${tail(output, 80)}`,
			}
		}
		outputs.push(`npm run ${script}: ok`)
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
	const result = await exec('npx', ['vitest', 'run', '--reporter=json', '--', ...files], {
		cwd: repoDir,
		signal,
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
	/** Tool allowlist (default: the full worker set) */
	tools?: readonly string[]
	/** JSON schema the session's final answer must match; parsed into `structuredOutput` */
	outputSchema?: Record<string, unknown>
}

export type SessionOutcome = {
	ok: boolean
	tokens: number
	result: string
	/** The structured answer when `outputSchema` was given and the session produced one */
	structuredOutput?: unknown
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
	tools = workerTools,
	outputSchema,
}: SessionInput): Promise<SessionOutcome> => {
	const controller = new AbortController()
	const onAbort = () => controller.abort(signal.reason)
	if (signal.aborted) onAbort()
	else signal.addEventListener('abort', onAbort, { once: true })

	const options: Options = {
		cwd,
		model: resolveWorkerModel(model),
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
		env: { ...sandboxEnv(), CLAUDE_AGENT_SDK_CLIENT_APP: 'mf-harness/0.1' },
	}

	const usage = createUsageAccumulator(onUsage)
	let ok = false
	let result = ''
	let structuredOutput: unknown
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
	return { ok, tokens: usage.total, result, structuredOutput }
}

// MARK: Task runner

export type RunTaskInput = {
	task: Task
	spec: Spec
	plan: Plan
	repoDir: string
	signal: AbortSignal
	onUsage: (usage: TokenUsage) => void
	model?: string
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
 * One task = one worktree + one agent session, then lint + test. When verification fails the
 * agent gets exactly one repair session with the output; still red → the task fails.
 */
export const runTask = async ({
	task,
	spec,
	plan,
	repoDir,
	signal,
	onUsage,
	model,
}: RunTaskInput): Promise<TaskOutcome> => {
	const { dir, branch } = await createWorktree(repoDir, task, signal)
	let tokens = 0
	const count = (usage: TokenUsage) => {
		tokens += totalTokens(usage)
		onUsage(usage)
	}
	const systemPrompt = workerSystemPrompt(spec, plan, task)

	const session = await runSession({
		cwd: dir,
		systemPrompt,
		prompt: `Implement the task "${task.title}" as described in your instructions. Start by reading CLAUDE.md, then work through the task, run lint + tests, fix, and commit.`,
		signal,
		onUsage: count,
		model,
	})
	if (signal.aborted) return { ok: false, tokens, branch, reason: 'aborted' }
	if (!session.ok) {
		return { ok: false, tokens, branch, reason: `agent session failed: ${session.result}` }
	}

	await commitLeftovers(dir, task, signal)
	let verification = await verifyRepo(dir, signal)
	if (!verification.ok) {
		const repair = await runSession({
			cwd: dir,
			systemPrompt,
			prompt: `Verification failed after your work. Fix it so that \`npm run lint\` and \`npm test\` pass, then commit.\n\n${verification.output}`,
			signal,
			onUsage: count,
			model,
			maxTurns: 80,
		})
		if (signal.aborted) return { ok: false, tokens, branch, reason: 'aborted' }
		if (!repair.ok) {
			return { ok: false, tokens, branch, reason: `repair session failed: ${repair.result}` }
		}
		await commitLeftovers(dir, task, signal)
		verification = await verifyRepo(dir, signal)
		if (!verification.ok) return { ok: false, tokens, branch, reason: verification.output }
	}
	if (!(await hasCommits(dir, branch, signal))) {
		return { ok: false, tokens, branch, reason: 'worker produced no commits' }
	}
	return { ok: true, tokens, branch }
}

/** True when the directory exists (used by callers that clean up worktrees defensively) */
export const exists = async (path: string) =>
	stat(path).then(
		() => true,
		() => false
	)

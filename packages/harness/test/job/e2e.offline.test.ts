import { cp, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createFakeDeliveryClients } from '#job/delivery/index.ts'
import { exec } from '#job/exec.ts'
import { runJob } from '#job/orchestrator.ts'
import { createLivePorts } from '#job/ports.ts'
import { createPlanner, planToolName } from '#job/planner.ts'
import { mergeTask } from '#job/merge.ts'
import { reviewGate } from '#job/gateSessions.ts'
import { runTask } from '#job/worker.ts'

import type Anthropic from '@anthropic-ai/sdk'
import type { NewJobEvent, Plan, Spec } from '@mf/models'
import type { FakeArtifactStore } from '#job/delivery/artifacts.ts'
import type { FakeGitHub } from '#job/delivery/github.ts'
import type { SpecEngineClient } from '#spec/specEngine.ts'
import type { JobInput, RunJobOptions } from '#job/types.ts'

// MARK: The @anthropic-ai/claude-agent-sdk seam
//
// Every worker/gate session goes through `runSession`, which imports `query` from the Agent SDK.
// We mock `query` with a stream that (a) makes small REAL edits to the worktree that keep the repo
// lint + test green, and (b) returns the right structured output for each model gate. The session
// is dispatched by its system prompt (`sessionRoleOf`), so one handler drives worker vs each gate.
// The mock delegates to a module-level `sessionHandler` so a test can install its own scenario.

type QueryInput = { prompt: string; options: { cwd: string; systemPrompt?: string } }
type SdkMessage = Record<string, unknown>

let sessionHandler: (input: QueryInput) => AsyncGenerator<SdkMessage>

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
	query: (input: QueryInput) => sessionHandler(input),
}))

// MARK: Canned SDK stream

let messageSeq = 0
const assistantMessage = (tokens = 20): SdkMessage => ({
	type: 'assistant',
	message: {
		id: `msg_${(messageSeq += 1)}`,
		usage: {
			input_tokens: tokens,
			output_tokens: 0,
			cache_read_input_tokens: 0,
			cache_creation_input_tokens: 0,
		},
	},
})
const successResult = (extra: SdkMessage = {}): SdkMessage => ({
	type: 'result',
	subtype: 'success',
	is_error: false,
	result: 'done',
	errors: [],
	num_turns: 1,
	total_cost_usd: 0,
	modelUsage: {},
	...extra,
})

// MARK: Session role + helpers

type SessionRole =
	| 'worker'
	| 'acceptance-tests'
	| 'acceptance-fix'
	| 'review'
	| 'review-fix'
	| 'acceptance-check'
	| 'merge'

const sessionRoleOf = (systemPrompt: string): SessionRole => {
	if (systemPrompt.includes('resolving a git merge conflict')) return 'merge'
	if (systemPrompt.includes('You are the QA engineer at Mjukvaruhuset')) return 'acceptance-tests'
	if (systemPrompt.includes('Acceptance tests derived from')) return 'acceptance-fix'
	if (systemPrompt.includes('You are the independent reviewer at Mjukvaruhuset')) return 'review'
	if (systemPrompt.includes('An independent review of the application')) return 'review-fix'
	if (systemPrompt.includes('You are the acceptance checker at Mjukvaruhuset')) return 'acceptance-check'
	return 'worker'
}

/** Criterion ids the gate prompt lists (`- [f0.c1] (Feature) text`) */
const criterionIdsOf = (systemPrompt: string) => [
	...new Set([...systemPrompt.matchAll(/\[(f\d+\.c\d+)\]/g)].map(match => match[1]!)),
]

const pascal = (id: string) =>
	id
		.split(/[^a-z0-9]+/i)
		.filter(Boolean)
		.map(part => part[0]!.toUpperCase() + part.slice(1))
		.join('')

const write = async (dir: string, relativePath: string, content: string) => {
	const full = join(dir, relativePath)
	await mkdir(dirname(full), { recursive: true })
	await writeFile(full, content)
}

type WorkerBehaviour = 'edit' | 'none' | 'broken'
type HandlerConfig = {
	/** What each worker session does, keyed by task id (default: a green edit) */
	worker?: (taskId: string) => WorkerBehaviour
	/** Findings the review session returns (default: none) */
	reviewFindings?: unknown[]
}

/** The default green handler: green worker edits + all gates satisfied */
const defaultHandler =
	(config: HandlerConfig = {}) =>
	async function* (input: QueryInput): AsyncGenerator<SdkMessage> {
		const systemPrompt = input.options.systemPrompt ?? ''
		const cwd = input.options.cwd
		const role = sessionRoleOf(systemPrompt)

		if (role === 'worker') {
			const taskId = basename(cwd)
			const behaviour = config.worker?.(taskId) ?? 'edit'
			const area = (systemPrompt.match(/^Areas: (.*)$/m)?.[1] ?? 'apps/api').split(',')[0]!.trim()
			if (behaviour === 'edit') {
				await write(cwd, `${area}/src/mfOffline${pascal(taskId)}.ts`, `export const mfOffline${pascal(taskId)} = true\n`)
			} else if (behaviour === 'broken') {
				// A real type error tsgo catches, so the scoped lint gate is genuinely red
				await write(cwd, `${area}/src/mfBroken.ts`, `export const broken: number = 'not a number'\n`)
			}
			yield assistantMessage()
			yield successResult()
			return
		}

		if (role === 'acceptance-tests') {
			// One passing acceptance test per criterion, in the api workspace (a real vitest project)
			for (const id of criterionIdsOf(systemPrompt)) {
				await write(cwd, `apps/api/test/acceptance/${id}.test.ts`, `it('[${id}] offline acceptance', () => {\n\texpect(true).toBe(true)\n})\n`)
			}
			yield assistantMessage()
			yield successResult()
			return
		}

		if (role === 'review') {
			yield assistantMessage()
			yield successResult({ structured_output: { findings: config.reviewFindings ?? [] } })
			return
		}

		if (role === 'acceptance-check') {
			const report = Object.fromEntries(
				criterionIdsOf(systemPrompt).map(id => [
					id,
					{ evidence: [`apps/api/test/acceptance/${id}.test.ts`], status: 'met' },
				])
			)
			yield assistantMessage()
			yield successResult({ structured_output: { report } })
			return
		}

		// acceptance-fix / review-fix: a no-op session (writes nothing)
		yield assistantMessage()
		yield successResult()
	}

// MARK: Repo seeding (mirrors apps/job seedRepo; node_modules hard-linked for test speed)

const templateDir = fileURLToPath(new URL('../../../../templates/web', import.meta.url))

const gitEnv = {
	GIT_AUTHOR_NAME: 'Mjukvaruhuset build',
	GIT_AUTHOR_EMAIL: 'build@mjukvaruhuset.se',
	GIT_COMMITTER_NAME: 'Mjukvaruhuset build',
	GIT_COMMITTER_EMAIL: 'build@mjukvaruhuset.se',
}

/**
 * Copies the golden template exactly like `apps/job/src/repo.ts` `seedRepo` (verbatim symlinks,
 * git init -b main, one commit) — but hard-links each `node_modules` instead of copying it, which
 * takes ~1 s instead of ~16 s and is what the real worktree sharing (`shareNodeModules`) does
 * anyway. The result is a real, installed repo where `npm run lint`/`npm test`/`vitest` run offline.
 */
const seedRepo = async () => {
	const root = await mkdtemp(join(tmpdir(), 'mf-e2e-'))
	const repoDir = join(root, 'repo')
	await mkdir(repoDir, { recursive: true })
	await cp(templateDir, repoDir, {
		recursive: true,
		verbatimSymlinks: true,
		filter: source => {
			if (source === templateDir) return true
			const parts = source.slice(templateDir.length + 1).split('/')
			return parts[0] !== '.git' && !parts.includes('node_modules')
		},
	})
	// Hard-link every node_modules of the template (the real seedRepo copies them in; a link is
	// identical content, and no session in these tests writes into node_modules)
	await exec(
		'bash',
		[
			'-c',
			`cd "${templateDir}" && find . -maxdepth 3 -name node_modules -type d | while read d; do mkdir -p "${repoDir}/$(dirname "$d")"; cp -al "$d" "${repoDir}/$d"; done`,
		],
		{ cwd: repoDir }
	)
	if (!(await exists(join(repoDir, '.gitignore')))) {
		await writeFile(join(repoDir, '.gitignore'), 'node_modules\ndist\ncoverage\n')
	}
	const run = (args: string[]) => exec('git', args, { cwd: repoDir, env: gitEnv })
	await run(['init', '-q', '-b', 'main'])
	await run(['config', 'core.hooksPath', '/dev/null'])
	await run(['config', 'user.name', gitEnv.GIT_AUTHOR_NAME])
	await run(['config', 'user.email', gitEnv.GIT_AUTHOR_EMAIL])
	await run(['add', '-A'])
	await run(['commit', '-q', '-m', 'chore: seed from template'])
	const seedCommit = (await run(['rev-parse', 'HEAD'])).stdout.trim()
	return { root, repoDir, seedCommit }
}

const exists = (path: string) => stat(path).then(() => true, () => false)

// MARK: Canned spec + plan + planner client

const spec: Spec = {
	goal: 'A small marketing site with a landing page and a contact form',
	users: ['visitors'],
	features: [
		{ title: 'Landing page', description: 'Hero and footer', acceptanceCriteria: ['The landing page renders a hero'] },
		{ title: 'Contact form', description: 'A form that validates the email', acceptanceCriteria: ['A visitor can submit the contact form'] },
	],
	nonGoals: ['No user accounts'],
	stackConstraints: [],
	sizeClass: 'S',
}

/** Foundation task + two that depend on it and run in parallel (`maxWorkers` 2) */
const plan: Plan = {
	summary: 'Scaffold the shell, then build the landing page and the contact form in parallel.',
	tasks: [
		{ id: 'foundation', title: 'Scaffold the app shell', description: 'Set up the shared page composition and test setup.', dependsOn: [], areas: ['apps/api'], acceptanceCriteriaIds: [] },
		{ id: 'landing', title: 'Landing page', description: 'Build the landing page hero and footer.', dependsOn: ['foundation'], areas: ['apps/app'], acceptanceCriteriaIds: ['f0.c0'] },
		{ id: 'contact', title: 'Contact form', description: 'Build the contact form with email validation.', dependsOn: ['foundation'], areas: ['apps/api'], acceptanceCriteriaIds: ['f1.c0'] },
	],
}

const planToolUse = (input: unknown): Anthropic.Message =>
	({
		id: 'msg_plan',
		type: 'message',
		role: 'assistant',
		model: 'fake',
		content: [{ type: 'tool_use', id: 'toolu_plan', name: planToolName, input }],
		stop_reason: 'tool_use',
		stop_sequence: null,
		usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 0 },
	}) as unknown as Anthropic.Message

const fakePlanClient = (...plans: unknown[]) => {
	const create = vi.fn<SpecEngineClient['messages']['create']>()
	plans.forEach(candidate => create.mockResolvedValueOnce(planToolUse(candidate)))
	return { client: { messages: { create } } satisfies SpecEngineClient, create }
}

// MARK: Test harness

const signal = new AbortController().signal
const collectEvents = (overrides: Partial<RunJobOptions['hooks']> = {}) => {
	const events: NewJobEvent[] = []
	const hooks: RunJobOptions['hooks'] = {
		emit: async event => void events.push(event),
		pollIntervalMs: 1_000_000,
		...overrides,
	}
	return { events, hooks, types: () => events.map(event => event.type) }
}

const jobInput = (repoDir: string, seedCommit: string): JobInput => ({
	id: '01234567-89ab-cdef-0123-456789abcdef',
	spec,
	budget: { maxTokens: 20_000_000, maxDurationMinutes: 30, maxWorkers: 2 },
	repoDir,
	seedCommit,
	delivery: { slug: 'marketing-site', appName: 'Marketing site' },
})

let logSpy: ReturnType<typeof vi.spyOn>
let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
	messageSeq = 0
	sessionHandler = defaultHandler()
	Object.assign(process.env, gitEnv)
	logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
	warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
	logSpy.mockRestore()
	warnSpy.mockRestore()
})

// MARK: The full offline happy path

describe('offline build-job e2e', () => {
	it('plans, builds the DAG, runs every gate green and delivers — no network, no model', async () => {
		const { root, repoDir, seedCommit } = await seedRepo()
		try {
			const delivery = createFakeDeliveryClients()
			const artifacts = delivery.artifacts as FakeArtifactStore
			const { client } = fakePlanClient(plan)
			const ports = createLivePorts({ client, delivery })
			const { events, hooks, types } = collectEvents()

			const outcome = await runJob(jobInput(repoDir, seedCommit), { ports, hooks })

			// Delivered with a real deliverable
			expect(outcome.status, outcome.reason).toBe('delivered')
			expect(outcome.plan?.tasks.map(task => task.id)).toEqual(['foundation', 'landing', 'contact'])
			expect(outcome.tokensUsed).toBeGreaterThan(0)
			expect(outcome.deliverable?.repositoryUrl).toBe(
				'https://github.com/mjukvaruhuset/marketing-site'
			)
			expect(outcome.deliverable?.deliverableKey).toBe(
				`deliverables/${jobInput(repoDir, seedCommit).id}/`
			)

			// Every gate ran, in order, and passed — verify + licence are the REAL deterministic gates
			expect(outcome.gates.map(gate => gate.name)).toEqual([
				'verify',
				'acceptance-tests',
				'review',
				'licence',
				'acceptance-check',
			])
			expect(outcome.gates.every(gate => gate.ok)).toBe(true)

			// The full event sequence
			expect(types().slice(0, 2)).toEqual(['started', 'planned'])
			expect(types().filter(type => type === 'task_started')).toHaveLength(3)
			expect(types().filter(type => type === 'task_finished')).toHaveLength(3)
			expect(types().filter(type => type === 'merge')).toHaveLength(3)
			expect(types().filter(type => type === 'gate')).toHaveLength(5)
			expect(
				events
					.filter(event => event.type === 'merge')
					.every(event => (event.payload as { ok: boolean }).ok)
			).toBe(true)
			const deliverySteps = events
				.filter(event => event.type === 'delivery')
				.map(event => (event.payload as { step: string }).step)
			expect(deliverySteps).toEqual(['docs', 'repo', 'deploy', 'bundle'])
			expect(types().at(-1)).toBe('done')

			// The fake artifact store received the whole bundle
			const prefix = `deliverables/${jobInput(repoDir, seedCommit).id}/`
			const keys = [...artifacts.objects.keys()]
			for (const name of ['repo.zip', 'HANDOVER.md', 'TEST-REPORT.md', 'gates.json', 'acceptance.json']) {
				expect(keys, name).toContain(`${prefix}${name}`)
			}
			expect(keys.some(key => key.startsWith(`${prefix}site/`))).toBe(true)
			// The gates bundle carries the real gate reports; acceptance.json the mapped criteria
			expect(JSON.parse(artifacts.objects.get(`${prefix}gates.json`)!.body as string)).toHaveLength(5)
			expect(JSON.parse(artifacts.objects.get(`${prefix}acceptance.json`)!.body as string)).toEqual({
				'f0.c0': { evidence: ['apps/api/test/acceptance/f0.c0.test.ts'], status: 'met' },
				'f1.c0': { evidence: ['apps/api/test/acceptance/f1.c0.test.ts'], status: 'met' },
			})

			// The pushed repo + preview were the fakes, so zero network happened
			expect((delivery.github as FakeGitHub).pushes).toHaveLength(1)
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	}, 180_000)
})

// MARK: Negative cases — each pins a bug class from the first live delivery (2026-08-27)

describe('offline build-job e2e — failure paths', () => {
	it('retries planning with a tool_result (not plain text) when the first plan is invalid', async () => {
		// Pins: the planner tool_result 400 — a plain-text correction after a tool_use is rejected
		const { client, create } = fakePlanClient({ summary: 'x', tasks: [] }, plan)

		const result = await createPlanner({ client }).plan({ spec })

		expect(result.tasks).toHaveLength(3)
		expect(create).toHaveBeenCalledTimes(2)
		const correction = create.mock.calls[1]![0].messages.at(-1)!
			.content as Anthropic.ToolResultBlockParam[]
		expect(correction[0]!.type).toBe('tool_result')
		expect(correction[0]!.tool_use_id).toBe('toolu_plan')
		expect(correction[0]!.is_error).toBe(true)
	})

	it('fails the task when the worker makes no commits', async () => {
		// Pins: an empty branch (git identity / index.lock / capped-with-nothing) must fail, not merge
		const { root, repoDir } = await seedRepo()
		try {
			sessionHandler = defaultHandler({ worker: () => 'none' })
			const task = plan.tasks[0]!
			const outcome = await runTask({ task, spec, plan, repoDir, signal, onUsage: () => {} })

			expect(outcome.ok).toBe(false)
			expect(outcome.reason).toMatch(/worker produced no commits/)
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	}, 180_000)

	it('fails the task closed when the gate stays lint-red', async () => {
		// Pins: a red gate must fail the task, never deliver broken code
		const { root, repoDir } = await seedRepo()
		try {
			sessionHandler = defaultHandler({ worker: () => 'broken' })
			const task = plan.tasks[0]!
			const outcome = await runTask({ task, spec, plan, repoDir, signal, onUsage: () => {} })

			expect(outcome.ok).toBe(false)
			expect(outcome.reason).toMatch(/lint/i)
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	}, 180_000)

	it('repairs a merge conflict: repair session → staged → merged', async () => {
		// Pins: the merge-repair staging bug (files resolved on disk reported "still conflicted")
		const root = await mkdtemp(join(tmpdir(), 'mf-merge-'))
		const repoDir = join(root, 'repo')
		try {
			await mkdir(repoDir, { recursive: true })
			const run = (args: string[]) => exec('git', args, { cwd: repoDir, env: gitEnv })
			await write(repoDir, 'shared.txt', 'base\n')
			await run(['init', '-q', '-b', 'main'])
			await run(['add', '-A'])
			await run(['commit', '-q', '-m', 'seed'])
			await run(['checkout', '-q', '-b', 'task/contact'])
			await write(repoDir, 'shared.txt', 'from the contact branch\n')
			await run(['commit', '-qam', 'contact'])
			await run(['checkout', '-q', 'main'])
			await write(repoDir, 'shared.txt', 'from main\n')
			await run(['commit', '-qam', 'main change'])

			// The repair session resolves the conflicted file (both sides kept), leaving no markers.
			// Parse only the "Conflicted files:" block of the prompt, not the convention bullets.
			sessionHandler = async function* (input) {
				const block = (input.options.systemPrompt ?? '').split('Conflicted files:\n')[1] ?? ''
				const files = block
					.split('\n\n')[0]!
					.split('\n')
					.map(line => line.replace(/^- /, '').trim())
					.filter(Boolean)
				for (const file of files) {
					await write(input.options.cwd, file, 'from main + contact (resolved)\n')
				}
				yield assistantMessage()
				yield successResult()
			}

			const outcome = await mergeTask({
				task: plan.tasks[2]!,
				branch: 'task/contact',
				spec,
				repoDir,
				signal,
				onUsage: () => {},
			})

			expect(outcome.ok, outcome.reason).toBe(true)
			const log = (await run(['log', '--oneline'])).stdout
			expect(log).toMatch(/conflicts resolved/)
			const merged = (await run(['show', 'HEAD:shared.txt'])).stdout
			expect(merged).toContain('resolved')
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	}, 180_000)

	it('fails the review gate closed on an unwaived high finding', async () => {
		// Pins: the independent review gate must fail closed when a high finding is left open
		const { root, repoDir, seedCommit } = await seedRepo()
		try {
			const high = {
				severity: 'high',
				file: 'apps/api/src/index.ts',
				line: 1,
				claim: 'unauthenticated write',
				failureScenario: 'anonymous request → data change',
			}
			sessionHandler = defaultHandler({ reviewFindings: [high] })

			const outcome = await reviewGate({
				spec,
				repoDir,
				seedCommit,
				waivers: [],
				signal,
				onUsage: () => {},
			})

			expect(outcome.ok).toBe(false)
			expect(outcome.summary).toMatch(/high finding\(s\) still open/)
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	}, 180_000)
})

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { exec } from '#job/exec.ts'
import {
	resolveWorkerModel,
	runSession,
	runTask,
	taskEfficiency,
	workerLimits,
} from '#job/worker.ts'

import type { Plan, Spec, Task } from '@mf/models'
import type { VerifyOutcome } from '#job/types.ts'
import type { SessionInput, SessionOutcome, VerifyOptions } from '#job/worker.ts'

// The SDK is only reached through `runSession`; `query` is a fake stream of result messages
const queue: Record<string, unknown>[][] = []
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
	query: () => {
		const messages = queue.shift() ?? []
		return (async function* () {
			yield* messages
		})()
	},
}))

const spec: Spec = {
	goal: 'x',
	users: [],
	features: [],
	nonGoals: [],
	stackConstraints: [],
	sizeClass: 'S',
}
const task: Task = {
	id: 'app-landing',
	title: 'Landing page',
	description: 'Build it',
	// A dependent (non-foundation) task: gated on the size cap, not the foundation floor
	dependsOn: ['app-foundation'],
	areas: ['apps/app'],
	acceptanceCriteriaIds: ['f0.c0'],
}
const plan: Plan = { summary: 'one task', tasks: [task] }

/** A git repo with a `main` branch the task worktree is created from */
const seedRepo = async () => {
	const root = await mkdtemp(join(tmpdir(), 'mf-task-'))
	const dir = join(root, 'repo')
	await mkdir(dir)
	const run = (args: string[]) => exec('git', args, { cwd: dir })
	await run(['init', '-q', '-b', 'main'])
	await run(['config', 'user.email', 'test@example.com'])
	await run(['config', 'user.name', 'test'])
	await writeFile(join(dir, 'README.md'), 'seed\n')
	await run(['add', '-A'])
	await run(['commit', '-q', '-m', 'seed'])
	return { root, dir }
}

type FakeSession = { edits?: Record<string, string>; outcome: Partial<SessionOutcome> }

/** Queued sessions: each one writes files into the worktree, then returns its outcome */
const fakeSessions = (sessions: FakeSession[]) => {
	const prompts: string[] = []
	const runFake = async (input: SessionInput): Promise<SessionOutcome> => {
		prompts.push(input.prompt)
		const next = sessions.shift()
		if (!next) throw new Error('unexpected session')
		for (const [file, content] of Object.entries(next.edits ?? {})) {
			await mkdir(join(input.cwd, file, '..'), { recursive: true })
			await writeFile(join(input.cwd, file), content)
		}
		input.onUsage({ inputTokens: 10, outputTokens: 5 })
		return { ok: true, tokens: 15, result: 'done', ...next.outcome }
	}
	return { prompts, runSession: runFake }
}

const fakeVerify = (outcomes: VerifyOutcome[]) => {
	const calls: VerifyOptions[] = []
	const verifyRepo = async (_dir: string, _signal?: AbortSignal, options: VerifyOptions = {}) => {
		calls.push(options)
		return outcomes.shift() ?? { ok: true, output: 'green' }
	}
	return { calls, verifyRepo }
}

const capped: Partial<SessionOutcome> = {
	ok: false,
	maxTurnsReached: true,
	result: 'error_max_turns: ',
}

describe('runTask', () => {
	let root: string
	let repoDir: string
	const signal = new AbortController().signal
	const onUsage = vi.fn()
	const log = vi.spyOn(console, 'log').mockImplementation(() => {})

	beforeEach(async () => {
		;({ root, dir: repoDir } = await seedRepo())
		log.mockClear()
	})
	afterEach(async () => {
		await rm(root, { recursive: true, force: true })
	})

	it('Gates on the changed files and reports a clean run without notes', async () => {
		const sessions = fakeSessions([{ edits: { 'apps/app/src/x.ts': 'x' }, outcome: {} }])
		const verify = fakeVerify([])
		const outcome = await runTask({
			task,
			spec,
			plan,
			repoDir,
			signal,
			onUsage,
			ports: { ...sessions, ...verify },
		})
		expect(outcome).toEqual({ ok: true, tokens: 15, branch: 'task/app-landing' })
		expect(sessions.prompts).toHaveLength(1)
		expect(verify.calls).toEqual([{ areas: ['apps/app'], changed: ['apps/app/src/x.ts'] }])
	})

	it('Runs a finishing session after a capped worker even when the gate is green, and notes the cap', async () => {
		const sessions = fakeSessions([
			{ edits: { 'apps/app/src/x.ts': 'x' }, outcome: capped },
			{ edits: { 'apps/app/src/y.ts': 'y' }, outcome: {} },
		])
		const verify = fakeVerify([])
		const outcome = await runTask({
			task,
			spec,
			plan,
			repoDir,
			signal,
			onUsage,
			ports: { ...sessions, ...verify },
		})
		expect(outcome).toEqual({
			ok: true,
			tokens: 30,
			branch: 'task/app-landing',
			notes: ['worker session hit its turn cap (80 turns for size S)'],
		})
		expect(sessions.prompts[1]).toContain('cut off by its turn cap (80 turns for size S)')
		expect(sessions.prompts[1]).toContain('the gate (`npm run lint --if-present -w apps/app`')
		expect(verify.calls).toHaveLength(2)
		expect(log).toHaveBeenCalledWith(
			JSON.stringify({
				message: 'turn cap reached',
				taskId: 'app-landing',
				session: 'worker session',
				cap: 80,
				size: 'S',
			})
		)
	})

	it('Gives the repair session the gate output plus the cap note, then passes', async () => {
		const sessions = fakeSessions([
			{ edits: { 'apps/app/src/x.ts': 'x' }, outcome: capped },
			{ edits: { 'apps/app/src/x.ts': 'fixed' }, outcome: {} },
		])
		const verify = fakeVerify([{ ok: false, output: 'eslint: boom' }])
		const outcome = await runTask({
			task,
			spec,
			plan,
			repoDir,
			signal,
			onUsage,
			ports: { ...sessions, ...verify },
		})
		expect(outcome.ok).toBe(true)
		expect(outcome.notes).toEqual(['worker session hit its turn cap (80 turns for size S)'])
		expect(sessions.prompts[1]).toContain(
			'Verification failed after your work (your session hit its turn cap: 80 turns for size S)'
		)
		expect(sessions.prompts[1]).toContain('eslint: boom')
	})

	it('Fails with both cap notes when the repair session is capped and the gate stays red', async () => {
		const sessions = fakeSessions([
			{ edits: { 'apps/app/src/x.ts': 'x' }, outcome: capped },
			{ edits: { 'apps/app/src/x.ts': 'still broken' }, outcome: capped },
		])
		const verify = fakeVerify([
			{ ok: false, output: 'eslint: boom' },
			{ ok: false, output: 'eslint: still boom' },
		])
		const outcome = await runTask({
			task,
			spec,
			plan,
			repoDir,
			signal,
			onUsage,
			ports: { ...sessions, ...verify },
		})
		expect(outcome.ok).toBe(false)
		expect(outcome.reason).toBe(
			`eslint: still boom (worker session hit its turn cap (80 turns for size S); repair session hit its turn cap (${workerLimits.repairTurns} turns for size S))`
		)
	})

	it('Widens the gate to the full repo when the worker changed files outside its areas', async () => {
		const sessions = fakeSessions([
			{ edits: { 'apps/app/src/x.ts': 'x', 'packages/models/schemas/Order.ts': 'z' }, outcome: {} },
		])
		const verify = fakeVerify([])
		const outcome = await runTask({
			task,
			spec,
			plan,
			repoDir,
			signal,
			onUsage,
			ports: { ...sessions, ...verify },
		})
		expect(outcome.ok).toBe(true)
		expect(outcome.notes).toEqual([
			'gate widened to the full repository (changes outside the task workspaces)',
		])
		expect(verify.calls[0]?.changed).toEqual([
			'apps/app/src/x.ts',
			'packages/models/schemas/Order.ts',
		])
	})

	it('Floors the foundation task (no dependencies) at the foundation turn count, above the S cap', async () => {
		const foundationTask: Task = { ...task, id: 'app-foundation', dependsOn: [] }
		const foundationPlan: Plan = { summary: 'one task', tasks: [foundationTask] }
		const sessions = fakeSessions([
			{ edits: { 'apps/app/src/x.ts': 'x' }, outcome: capped },
			{ edits: { 'apps/app/src/y.ts': 'y' }, outcome: {} },
		])
		const outcome = await runTask({
			task: foundationTask,
			spec,
			plan: foundationPlan,
			repoDir,
			signal,
			onUsage,
			ports: { ...sessions, ...fakeVerify([]) },
		})
		// Size S caps at 80, but the dependency-free foundation task is floored at the foundation cost
		expect(outcome.notes).toEqual([
			`worker session hit its turn cap (${workerLimits.foundationTurns} turns for size S)`,
		])
		expect(workerLimits.foundationTurns).toBeGreaterThan(workerLimits.maxTurnsBySize.S)
	})

	it('Logs a per-task efficiency summary: turns, scoped gate, one gate run, cost from the usage', async () => {
		const sessions = fakeSessions([{ edits: { 'apps/app/src/x.ts': 'x' }, outcome: { turns: 12 } }])
		const outcome = await runTask({
			task,
			spec,
			plan,
			repoDir,
			signal,
			onUsage,
			ports: { ...sessions, ...fakeVerify([]) },
		})
		expect(outcome.ok).toBe(true)
		expect(log).toHaveBeenCalledWith(
			JSON.stringify(
				taskEfficiency({
					taskId: 'app-landing',
					size: 'S',
					model: resolveWorkerModel(),
					turns: 12,
					turnCap: 80,
					capHit: false,
					gateRuns: 1,
					scopedGate: true,
					usage: {
						inputTokens: 10,
						outputTokens: 5,
						cacheReadInputTokens: 0,
						cacheCreationInputTokens: 0,
					},
				})
			)
		)
	})

	it('Marks the efficiency summary full-gate and two gate runs when the gate widened and a repair ran', async () => {
		const sessions = fakeSessions([
			{
				edits: { 'apps/app/src/x.ts': 'x', 'packages/models/schemas/Order.ts': 'z' },
				outcome: capped,
			},
			{ edits: { 'apps/app/src/x.ts': 'fixed' }, outcome: { turns: 7 } },
		])
		const outcome = await runTask({
			task,
			spec,
			plan,
			repoDir,
			signal,
			onUsage,
			ports: { ...sessions, ...fakeVerify([{ ok: false, output: 'boom' }]) },
		})
		expect(outcome.ok).toBe(true)
		const summary = log.mock.calls
			.map(([line]) => JSON.parse(String(line)))
			.find(entry => entry.message === 'task efficiency')
		expect(summary).toMatchObject({ scopedGate: false, gateRuns: 2, capHit: true, turns: 7 })
	})

	it('Fails a session that errored without hitting its cap', async () => {
		const sessions = fakeSessions([{ outcome: { ok: false, result: 'error_during_execution: x' } }])
		const outcome = await runTask({
			task,
			spec,
			plan,
			repoDir,
			signal,
			onUsage,
			ports: { ...sessions, ...fakeVerify([]) },
		})
		expect(outcome).toMatchObject({
			ok: false,
			reason: 'agent session failed: error_during_execution: x',
		})
		expect(sessions.prompts).toHaveLength(1)
	})
})

describe('runSession', () => {
	const input = {
		cwd: '/tmp',
		systemPrompt: 'sys',
		prompt: 'go',
		signal: new AbortController().signal,
		onUsage: vi.fn(),
	}
	vi.spyOn(console, 'log').mockImplementation(() => {})

	it('Maps error_max_turns to maxTurnsReached (not ok) with the subtype in the result', async () => {
		queue.push([
			{
				type: 'result',
				subtype: 'error_max_turns',
				is_error: true,
				errors: ['60 turns'],
				num_turns: 60,
			},
		])
		const outcome = await runSession(input)
		expect(outcome).toMatchObject({
			ok: false,
			maxTurnsReached: true,
			result: 'error_max_turns: 60 turns',
		})
	})

	it('Is ok without the flag on success', async () => {
		queue.push([
			{ type: 'result', subtype: 'success', is_error: false, result: 'done', num_turns: 3 },
		])
		const outcome = await runSession(input)
		expect(outcome).toMatchObject({ ok: true, maxTurnsReached: false, result: 'done' })
	})
})

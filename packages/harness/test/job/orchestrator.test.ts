import { runJob } from '#job/orchestrator.ts'

import type { NewJobEvent, Plan, Spec, Task } from '@mf/models'
import type { OrchestratorPorts, RunJobOptions, TokenUsage } from '#job/types.ts'

// MARK: Fixtures

const spec: Spec = {
	goal: 'x',
	users: [],
	features: [],
	nonGoals: [],
	stackConstraints: [],
}

const task = (id: string, dependsOn: string[] = []): Task => ({
	id,
	title: id,
	description: id,
	dependsOn,
	areas: [],
	acceptanceCriteriaIds: [],
})

/** a → b, a → c, (b, c) → d */
const diamond: Plan = {
	summary: 'diamond',
	tasks: [task('a'), task('b', ['a']), task('c', ['a']), task('d', ['b', 'c'])],
}

const job = (overrides: Partial<Parameters<typeof runJob>[0]['budget']> = {}) => ({
	id: 'job-1',
	spec,
	repoDir: '/tmp/repo',
	budget: { maxTokens: 1_000_000, maxDurationMinutes: 60, maxWorkers: 2, ...overrides },
})

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

type FakeOptions = {
	plan?: Plan
	taskTokens?: number
	/** Task ids that should fail */
	failing?: string[]
	/** Resolve tasks manually (returns a release function per task) */
	manual?: boolean
}

/** In-memory ports: no git, no network. Records ordering + concurrency. */
const createFakePorts = ({
	plan = diamond,
	taskTokens = 100,
	failing = [],
	manual = false,
}: FakeOptions = {}) => {
	const started: string[] = []
	const merged: string[] = []
	const releases = new Map<string, () => void>()
	let inFlight = 0
	let maxInFlight = 0

	const ports: OrchestratorPorts = {
		plan: vi.fn(async ({ onUsage }) => {
			onUsage({ inputTokens: 500, outputTokens: 100 })
			return plan
		}),
		runTask: vi.fn(async ({ task: current, onUsage }) => {
			started.push(current.id)
			inFlight += 1
			maxInFlight = Math.max(maxInFlight, inFlight)
			if (manual) await new Promise<void>(resolve => releases.set(current.id, resolve))
			else await tick()
			inFlight -= 1
			onUsage({ inputTokens: taskTokens, outputTokens: 0 })
			const ok = !failing.includes(current.id)
			return {
				ok,
				tokens: taskTokens,
				branch: `task/${current.id}`,
				reason: ok ? undefined : 'boom',
			}
		}),
		mergeTask: vi.fn(async ({ task: current }) => {
			merged.push(current.id)
			return { ok: true, tokens: 0 }
		}),
		verify: vi.fn(async () => ({ ok: true, output: 'green' })),
		acceptanceTests: vi.fn(async () => ({ ok: true, tokens: 0, summary: 'tests green' })),
		review: vi.fn(async () => ({ ok: true, tokens: 0, summary: 'no findings' })),
		licence: vi.fn(async () => ({ ok: true, tokens: 0, summary: 'none denied' })),
		acceptanceCheck: vi.fn(async () => ({ ok: true, tokens: 0, summary: 'all met' })),
	}

	const release = async (id: string) => {
		while (!releases.has(id)) await tick()
		releases.get(id)!()
		releases.delete(id)
		await tick()
		await tick()
	}

	return { ports, started, merged, release, maxInFlight: () => maxInFlight }
}

const createHooks = (overrides: Partial<RunJobOptions['hooks']> = {}) => {
	const events: NewJobEvent[] = []
	const tokens: number[] = []
	const hooks: RunJobOptions['hooks'] = {
		emit: vi.fn(async event => {
			events.push(event)
		}),
		onTokens: vi.fn(async used => {
			tokens.push(used)
		}),
		pollIntervalMs: 5,
		...overrides,
	}
	return { hooks, events, tokens, types: () => events.map(event => event.type) }
}

// MARK: Tests

describe('runJob', () => {
	it('Plans, runs the DAG with bounded concurrency, merges in dependency order and delivers', async () => {
		const fake = createFakePorts()
		const { hooks, events, types, tokens } = createHooks()

		const outcome = await runJob(job(), { ports: fake.ports, hooks })

		expect(outcome.status).toBe('delivered')
		expect(outcome.plan).toEqual(diamond)
		// a first, d last; b and c ran in parallel but never more than maxWorkers
		expect(fake.started[0]).toBe('a')
		expect(fake.started.at(-1)).toBe('d')
		expect(fake.maxInFlight()).toBe(2)
		expect(fake.merged[0]).toBe('a')
		expect(fake.merged.at(-1)).toBe('d')
		expect(fake.merged.toSorted()).toEqual(['a', 'b', 'c', 'd'])
		// Every task was merged before its dependants started
		const dIndex = fake.started.indexOf('d')
		expect(fake.merged.indexOf('b')).toBeLessThan(dIndex + 1)
		expect(fake.merged.indexOf('c')).toBeLessThan(dIndex + 1)

		expect(types()[0]).toBe('started')
		expect(types()[1]).toBe('planned')
		expect(events[1]!.payload.plan).toEqual(diamond)
		expect(types().filter(t => t === 'task_started')).toHaveLength(4)
		expect(types().filter(t => t === 'task_finished')).toHaveLength(4)
		expect(types().filter(t => t === 'merge')).toHaveLength(4)
		expect(types().slice(-6)).toEqual(['gate', 'gate', 'gate', 'gate', 'gate', 'done'])
		// planner 600 + 4 × 100
		expect(outcome.tokensUsed).toBe(1000)
		expect(tokens.at(-1)).toBe(1000)
	})

	it('Respects maxWorkers = 1 (strictly sequential)', async () => {
		const fake = createFakePorts()
		const { hooks } = createHooks()

		await runJob(job({ maxWorkers: 1 }), { ports: fake.ports, hooks })

		expect(fake.maxInFlight()).toBe(1)
		expect(fake.started).toEqual(['a', 'b', 'c', 'd'])
	})

	it('Fails closed when a task fails and skips its dependants', async () => {
		const fake = createFakePorts({ failing: ['b'] })
		const { hooks, types } = createHooks()

		const outcome = await runJob(job(), { ports: fake.ports, hooks })

		expect(outcome.status).toBe('failed')
		expect(outcome.reason).toMatch(/b: boom/)
		expect(outcome.reason).toMatch(/blocked.*d/)
		expect(fake.started).not.toContain('d')
		expect(fake.started).toContain('c')
		expect(fake.merged).toEqual(['a', 'c'])
		expect(types()).toContain('task_failed')
		expect(types().slice(-2)).toEqual(['failed', 'notify'])
		expect(fake.ports.verify).not.toHaveBeenCalled()
	})

	it('Fails when a merge conflict cannot be repaired', async () => {
		const fake = createFakePorts()
		vi.mocked(fake.ports.mergeTask).mockImplementation(async ({ task: current }) =>
			current.id === 'c'
				? { ok: false, tokens: 0, reason: 'still conflicted' }
				: { ok: true, tokens: 0 }
		)
		const { hooks } = createHooks()

		const outcome = await runJob(job(), { ports: fake.ports, hooks })

		expect(outcome.status).toBe('failed')
		expect(outcome.reason).toMatch(/c: still conflicted/)
		expect(fake.started).not.toContain('d')
	})

	it('Fails (does not throw) when mergeTask rejects, and clears the poll interval', async () => {
		const fake = createFakePorts()
		vi.mocked(fake.ports.mergeTask).mockRejectedValue(new Error('git checkout main failed'))
		const { hooks, types } = createHooks()
		const clearSpy = vi.spyOn(globalThis, 'clearInterval')

		const outcome = await runJob(job(), { ports: fake.ports, hooks })

		expect(outcome.status).toBe('failed')
		expect(outcome.reason).toMatch(/a: git checkout main failed/)
		expect(types().slice(-2)).toEqual(['failed', 'notify'])
		expect(clearSpy).toHaveBeenCalledTimes(1)
		clearSpy.mockRestore()
	})

	it('Fails (does not throw) when verify rejects', async () => {
		const fake = createFakePorts()
		vi.mocked(fake.ports.verify).mockRejectedValue(new Error('spawn npm ENOENT'))
		const { hooks, types } = createHooks()

		const outcome = await runJob(job(), { ports: fake.ports, hooks })

		expect(outcome.status).toBe('failed')
		expect(outcome.reason).toMatch(
			/gate\(s\) failed: verify\nverify: gate crashed: spawn npm ENOENT/
		)
		expect(types().slice(-3)).toEqual(['gate', 'failed', 'notify'])
	})

	it('Reports killed when a merge rejects because of the kill abort', async () => {
		const fake = createFakePorts()
		let killed = false
		vi.mocked(fake.ports.mergeTask).mockImplementation(async ({ signal }) => {
			killed = true
			await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve()))
			throw new Error('AbortError')
		})
		const { hooks, types } = createHooks({ isKilled: async () => killed })

		const outcome = await runJob(job(), { ports: fake.ports, hooks })

		expect(outcome.status).toBe('killed')
		expect(types().slice(-2)).toEqual(['killed', 'notify'])
	})

	it('Fails when the final verification is red', async () => {
		const fake = createFakePorts()
		vi.mocked(fake.ports.verify).mockResolvedValue({ ok: false, output: 'npm test failed' })
		const { hooks, types } = createHooks()

		const outcome = await runJob(job(), { ports: fake.ports, hooks })

		expect(outcome.status).toBe('failed')
		expect(outcome.reason).toMatch(/npm test failed/)
		expect(types().slice(-3)).toEqual(['gate', 'failed', 'notify'])
	})

	it('Aborts every in-flight session when the token budget is exceeded', async () => {
		const fake = createFakePorts({ manual: true, taskTokens: 400 })
		const signals: AbortSignal[] = []
		vi.mocked(fake.ports.runTask).mockImplementation(async ({ task: current, signal, onUsage }) => {
			signals.push(signal)
			fake.started.push(current.id)
			// Simulate streaming usage: crosses the 1 000 cap during task "b"
			onUsage({ inputTokens: current.id === 'a' ? 100 : 600, outputTokens: 0 })
			await new Promise(resolve => setTimeout(resolve, 5))
			return { ok: !signal.aborted, tokens: 0, branch: `task/${current.id}`, reason: 'aborted' }
		})
		const { hooks, types } = createHooks()

		const outcome = await runJob(job({ maxTokens: 1000 }), { ports: fake.ports, hooks })

		expect(outcome.status).toBe('failed')
		expect(outcome.reason).toBe('budget exceeded')
		expect(signals.every(signal => signal.aborted)).toBe(true)
		expect(types().slice(-2)).toEqual(['failed', 'notify'])
		expect(fake.started).not.toContain('d')
	})

	it('Aborts on out-of-band spend fed through attachProxyUsage (D1 proxy metering)', async () => {
		const fake = createFakePorts()
		const { hooks, types } = createHooks({
			// The orchestrator attaches the budget's proxy-observed ledger at start; a worker curling
			// the proxy directly (invisible to the SDK's onUsage) then burns the same budget.
			attachProxyUsage: report => {
				report({ inputTokens: 1500, outputTokens: 0 })
			},
		})

		const outcome = await runJob(job({ maxTokens: 1000 }), { ports: fake.ports, hooks })

		expect(outcome.status).toBe('failed')
		expect(outcome.reason).toBe('budget exceeded')
		expect(fake.ports.runTask).not.toHaveBeenCalled()
		expect(types().slice(-2)).toEqual(['failed', 'notify'])
	})

	it('Fails immediately when the planner alone exhausts the budget', async () => {
		const fake = createFakePorts()
		const { hooks } = createHooks()

		const outcome = await runJob(job({ maxTokens: 300 }), { ports: fake.ports, hooks })

		expect(outcome.status).toBe('failed')
		expect(outcome.reason).toBe('budget exceeded')
		expect(fake.ports.runTask).not.toHaveBeenCalled()
	})

	it('Fails on the wall-clock limit', async () => {
		let clock = 0
		const fake = createFakePorts({ manual: true })
		const { hooks } = createHooks()

		const promise = runJob(job({ maxDurationMinutes: 10 }), {
			ports: fake.ports,
			hooks,
			now: () => clock,
		})
		await fake.release('a')
		clock = 11 * 60_000
		await new Promise(resolve => setTimeout(resolve, 20))
		await fake.release('b')
		await fake.release('c')

		const outcome = await promise
		expect(outcome.status).toBe('failed')
		expect(outcome.reason).toBe('duration exceeded')
	})

	it('Honours the kill switch: status killed, in-flight sessions aborted', async () => {
		const fake = createFakePorts({ manual: true })
		let killed = false
		const signals: AbortSignal[] = []
		vi.mocked(fake.ports.runTask).mockImplementation(async ({ task: current, signal }) => {
			signals.push(signal)
			fake.started.push(current.id)
			await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve()))
			return { ok: false, tokens: 0, branch: `task/${current.id}`, reason: 'aborted' }
		})
		const { hooks, types } = createHooks({ isKilled: async () => killed })

		const promise = runJob(job(), { ports: fake.ports, hooks })
		await tick()
		killed = true

		const outcome = await promise
		expect(outcome.status).toBe('killed')
		expect(outcome.reason).toBe('killed')
		expect(signals.length).toBeGreaterThan(0)
		expect(signals.every(signal => signal.aborted)).toBe(true)
		expect(types().slice(-2)).toEqual(['killed', 'notify'])
	})

	it('Reports a planner failure without running tasks', async () => {
		const fake = createFakePorts()
		vi.mocked(fake.ports.plan).mockRejectedValue(new Error('model did not call submit_plan'))
		const { hooks, types } = createHooks()

		const outcome = await runJob(job(), { ports: fake.ports, hooks })

		expect(outcome.status).toBe('failed')
		expect(outcome.reason).toMatch(/planning failed: model did not call/)
		expect(types()).toEqual(['started', 'failed', 'notify'])
	})

	// ORC-10: `runJob` validated nothing about the plan it was handed (only `parsePlan` did, and
	// the replay/cassette path, gates-demo and any resume path bypass it). A cyclic plan started
	// zero tasks, recorded zero failures and ran the whole gate chain — including delivery — over
	// a repo where nothing had happened.
	it('Fails closed on an unschedulable plan instead of gating an untouched repo', async () => {
		const cyclic: Plan = { summary: 'cycle', tasks: [task('a', ['b']), task('b', ['a'])] }
		const fake = createFakePorts({ plan: cyclic })
		const { hooks, types } = createHooks()

		const outcome = await runJob(job(), { ports: fake.ports, hooks })

		expect(outcome.status).toBe('failed')
		expect(outcome.reason).toMatch(/plan is not schedulable \(cycle\)/)
		expect(fake.started).toEqual([])
		expect(fake.ports.verify).not.toHaveBeenCalled()
		expect(fake.ports.review).not.toHaveBeenCalled()
		expect(types()).toEqual(['started', 'failed', 'notify'])
	})

	it('Fails closed on a plan with an unknown dependency', async () => {
		const dangling: Plan = { summary: 'dangling', tasks: [task('a', ['ghost'])] }
		const fake = createFakePorts({ plan: dangling })
		const { hooks } = createHooks()

		const outcome = await runJob(job(), { ports: fake.ports, hooks })

		expect(outcome.status).toBe('failed')
		expect(outcome.reason).toMatch(/plan is not schedulable \(unknownDependency\): a → ghost/)
		expect(fake.started).toEqual([])
	})

	it('Fails closed on a plan with no tasks at all', async () => {
		const fake = createFakePorts({ plan: { summary: 'empty', tasks: [] } })
		const { hooks } = createHooks()

		const outcome = await runJob(job(), { ports: fake.ports, hooks })

		expect(outcome.status).toBe('failed')
		expect(outcome.reason).toMatch(/no tasks/)
		expect(fake.ports.verify).not.toHaveBeenCalled()
	})

	// The scheduler's own backstop: a valid DAG that still cannot make progress (here because no
	// worker slot exists) must be a hard failure, not a fall-through to the gates.
	it('Fails closed when the scheduler can make no progress on a valid DAG', async () => {
		const fake = createFakePorts()
		const { hooks } = createHooks()

		const outcome = await runJob(job({ maxWorkers: 0 }), { ports: fake.ports, hooks })

		expect(outcome.status).toBe('failed')
		expect(outcome.reason).toMatch(/no runnable task left — the plan is not schedulable/)
		expect(fake.started).toEqual([])
		expect(fake.ports.verify).not.toHaveBeenCalled()
	})

	it('Forwards the delivery reason of a delivered build whose preview URL was withheld', async () => {
		// The repo + bundle contract is honoured (status `delivered`), but the deploy/live-check
		// side withheld the URL: the api must be told WHY, not just see `deployUrl: null`.
		const fake = createFakePorts()
		const { hooks, events } = createHooks()
		const deliverable = {
			jobId: 'job-1',
			repositoryUrl: 'https://github.com/mjukvaruhuset/x',
			transferPending: false,
			deployUrl: null,
			siteUrl: null,
			deliverableKey: 'deliverables/job-1/',
			files: [],
			deliveredAt: '2026-09-02T00:00:00.000Z',
		}
		fake.ports.deliver = vi.fn(async () => ({
			ok: true,
			tokens: 0,
			steps: [],
			deliverable,
			reason: 'acceptance: blank page',
		}))

		const outcome = await runJob(
			{ ...job(), delivery: { slug: 'x', appName: 'X' } },
			{ ports: fake.ports, hooks }
		)

		expect(outcome.status).toBe('delivered')
		expect(outcome.reason).toBe('acceptance: blank page')
		expect(outcome.deliverable).toBe(deliverable)
		expect(events.at(-1)).toMatchObject({
			type: 'done',
			payload: { deployUrl: null, reason: 'acceptance: blank page' },
		})
	})

	it('Delivers without a reason when the preview came up', async () => {
		const fake = createFakePorts()
		const { hooks, events } = createHooks()
		fake.ports.deliver = vi.fn(async () => ({
			ok: true,
			tokens: 0,
			steps: [],
			deliverable: { deployUrl: 'https://preview.on.aws' } as never,
		}))

		const outcome = await runJob(
			{ ...job(), delivery: { slug: 'x', appName: 'X' } },
			{ ports: fake.ports, hooks }
		)

		expect(outcome.status).toBe('delivered')
		expect(outcome.reason).toBeUndefined()
		expect(events.at(-1)?.payload).toMatchObject({ deployUrl: 'https://preview.on.aws' })
	})

	it('Keeps going when the event sink throws', async () => {
		const fake = createFakePorts()
		const { hooks } = createHooks({ emit: vi.fn().mockRejectedValue(new Error('db down')) })

		const outcome = await runJob(job(), { ports: fake.ports, hooks })

		expect(outcome.status).toBe('delivered')
	})

	it('Persists tokens after every task, merge and at the end', async () => {
		const fake = createFakePorts()
		const { hooks, tokens } = createHooks()

		await runJob(job(), { ports: fake.ports, hooks })

		expect(tokens.length).toBeGreaterThanOrEqual(5)
		expect(tokens).toEqual([...tokens].toSorted((a, b) => a - b))
	})
})

/** Type guard so the fixtures above stay honest about the usage shape */
export const isUsage = (value: unknown): value is TokenUsage =>
	typeof value === 'object' && value !== null && 'inputTokens' in value

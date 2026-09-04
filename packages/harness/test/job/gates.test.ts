import { GateReportSchema, NotifyPayloadSchema } from '@mf/models'

import {
	failureNotification,
	gateBudgetFor,
	gateOrder,
	gatesFailedReason,
	runGates,
} from '#job/gates.ts'

import type { NewJobEvent, Spec } from '@mf/models'
import type { GateOutcome, OrchestratorPorts } from '#job/types.ts'

// MARK: Fixtures

const spec: Spec = {
	goal: 'x',
	users: [],
	features: [{ title: 'f', description: '', acceptanceCriteria: ['a'] }],
	nonGoals: [],
	stackConstraints: [],
}

const green = (summary: string): GateOutcome => ({ ok: true, tokens: 0, summary })

type FakeOptions = {
	verifyOk?: boolean
	acceptanceTests?: GateOutcome | Error
	review?: GateOutcome | Error
	licence?: GateOutcome | Error
	acceptanceCheck?: GateOutcome | Error
}

const gateFn = (outcome: GateOutcome | Error, tokens = 100) =>
	vi.fn(
		async ({
			onUsage,
		}: {
			onUsage: (usage: { inputTokens: number; outputTokens: number }) => void
		}) => {
			onUsage({ inputTokens: tokens, outputTokens: 0 })
			if (outcome instanceof Error) throw outcome
			return outcome
		}
	)

/** Ports where only the gate members matter; the build ports are never called by runGates */
const createPorts = ({
	verifyOk = true,
	acceptanceTests = green('tests green'),
	review = green('no findings'),
	licence = green('none denied'),
	acceptanceCheck = green('all met'),
}: FakeOptions = {}) => {
	const calls: string[] = []
	const record = <T extends (...args: never[]) => unknown>(name: string, fn: T) =>
		vi.fn((...args: Parameters<T>) => {
			calls.push(name)
			return fn(...args)
		}) as unknown as T
	const ports: OrchestratorPorts = {
		plan: vi.fn(),
		runTask: vi.fn(),
		mergeTask: vi.fn(),
		verify: record(
			'verify',
			vi.fn(async () => ({ ok: verifyOk, output: verifyOk ? 'ok' : 'lint red' }))
		),
		acceptanceTests: record('acceptance-tests', gateFn(acceptanceTests)),
		review: record('review', gateFn(review)),
		// Deterministic: never reports usage
		licence: record(
			'licence',
			vi.fn(async () => {
				if (licence instanceof Error) throw licence
				return licence
			})
		),
		acceptanceCheck: record('acceptance-check', gateFn(acceptanceCheck)),
	}
	return { ports, calls }
}

const run = (ports: OrchestratorPorts, overrides: Partial<Parameters<typeof runGates>[0]> = {}) => {
	const events: NewJobEvent[] = []
	const usage: number[] = []
	let clock = 1_000
	const outcome = runGates({
		spec,
		repoDir: '/tmp/repo',
		waivers: [],
		signal: new AbortController().signal,
		onUsage: u => usage.push(u.inputTokens + u.outputTokens),
		ports,
		emit: async event => {
			events.push(event)
		},
		isAborted: () => false,
		now: () => (clock += 500),
		...overrides,
	})
	return { outcome, events, usage }
}

// MARK: Tests

describe('runGates', () => {
	it('Runs every gate in order, emits one gate event each and passes', async () => {
		const { ports, calls } = createPorts()
		const { outcome, events } = run(ports)
		const result = await outcome

		expect(result.ok).toBe(true)
		expect(result.failed).toEqual([])
		expect(calls).toEqual([...gateOrder])
		expect(result.reports.map(r => r.name)).toEqual([
			'verify',
			'acceptance-tests',
			'review',
			'licence',
			'acceptance-check',
		])
		expect(events.map(e => e.type)).toEqual(['gate', 'gate', 'gate', 'gate', 'gate'])
		events.forEach(event => expect(GateReportSchema.parse(event.payload)).toBeTruthy())
	})

	it('Produces schema-valid reports with duration and tokens per gate', async () => {
		const { ports } = createPorts()
		const { reports } = await run(ports).outcome

		const review = reports.find(r => r.name === 'review')!
		expect(GateReportSchema.parse(review)).toEqual(review)
		expect(review.durationMs).toBe(500)
		expect(review.tokens).toBe(100)
		expect(review.summary).toBe('no findings')
		expect(reports.find(r => r.name === 'verify')!.tokens).toBe(0)
	})

	it('Fails closed on a red verify: nothing else runs', async () => {
		const { ports, calls } = createPorts({ verifyOk: false })
		const result = await run(ports).outcome

		expect(result.ok).toBe(false)
		expect(result.failed).toEqual(['verify'])
		expect(calls).toEqual(['verify'])
		expect(result.reports).toHaveLength(1)
		expect(result.reports[0]!.summary).toBe('lint red')
	})

	it('Stops at the first red gate and lists it in the reason', async () => {
		const { ports, calls } = createPorts({
			review: { ok: false, tokens: 0, summary: '1 high finding still open' },
		})
		const result = await run(ports).outcome

		expect(result.failed).toEqual(['review'])
		expect(calls).toEqual(['verify', 'acceptance-tests', 'review'])
		expect(gatesFailedReason(result.reports)).toBe(
			'1 gate(s) failed: review\nreview: 1 high finding still open'
		)
	})

	it('Runs the licence gate after review and before the acceptance check, red stops the chain', async () => {
		const { ports, calls } = createPorts({
			licence: {
				ok: false,
				tokens: 0,
				summary: '1 package(s) with a denied licence: x@1.0.0 (GPL-3.0-only)',
			},
		})
		const result = await run(ports).outcome

		expect(result.failed).toEqual(['licence'])
		expect(calls).toEqual(['verify', 'acceptance-tests', 'review', 'licence'])
		expect(ports.acceptanceCheck).not.toHaveBeenCalled()
		expect(result.reports.at(-1)!.tokens).toBe(0)
	})

	it('Counts a gate that throws as red, keeping its tokens', async () => {
		const { ports } = createPorts({ acceptanceTests: new Error('spawn npm ENOENT') })
		const { outcome, usage } = run(ports)
		const result = await outcome

		expect(result.failed).toEqual(['acceptance-tests'])
		expect(result.reports.at(-1)!.summary).toBe('gate crashed: spawn npm ENOENT')
		expect(result.reports.at(-1)!.tokens).toBe(100)
		expect(usage).toEqual([100])
	})

	it('Reports usage of every gate to the job budget', async () => {
		const { ports } = createPorts()
		const { outcome, usage } = run(ports)
		await outcome

		expect(usage).toEqual([100, 100, 100])
	})

	it('Stops without a report for the interrupted gate on abort', async () => {
		let aborted = false
		const { ports, calls } = createPorts()
		vi.mocked(ports.acceptanceTests).mockImplementation(async () => {
			calls.push('acceptance-tests')
			aborted = true
			return green('never counted')
		})
		const result = await run(ports, { isAborted: () => aborted }).outcome

		expect(result.ok).toBe(false)
		expect(result.failed).toEqual([])
		expect(result.reports.map(r => r.name)).toEqual(['verify'])
		expect(calls).toEqual(['verify', 'acceptance-tests'])
	})

	it('Passes spec, repo, waivers and seed commit through to the gate ports', async () => {
		const { ports } = createPorts()
		await run(ports, { waivers: ['a.ts:1'], seedCommit: 'abc' }).outcome

		expect(ports.review).toHaveBeenCalledWith(
			expect.objectContaining({
				spec,
				repoDir: '/tmp/repo',
				waivers: ['a.ts:1'],
				seedCommit: 'abc',
			})
		)
	})
})

// MARK: Budget guard rails

/** A job budget with `left` tokens still on it, guard rails scaled to a 9M S-class budget */
const withBudget = (left: number) => ({
	budget: { ...gateBudgetFor(9_000_000), remaining: () => left },
})

describe('runGates under a job budget', () => {
	it('Refuses a model gate the job cannot pay for, without starting it (job d0339616)', async () => {
		const { ports, calls } = createPorts()
		// What job d0339616 actually had left after its build phase: 374k against a 1.4M chain
		const { outcome, events } = run(ports, withBudget(374_000))
		const result = await outcome

		expect(result.ok).toBe(false)
		expect(result.exhausted).toBe('acceptance-tests')
		expect(result.failed).toEqual(['acceptance-tests'])
		// Free lint + test still ran; the expensive session never started
		expect(calls).toEqual(['verify'])
		expect(ports.acceptanceTests).not.toHaveBeenCalled()
		const report = result.reports.at(-1)!
		expect(report).toMatchObject({ name: 'acceptance-tests', ok: false, tokens: 0 })
		expect(report.summary).toContain('the remaining gates need about 1.4M')
		expect(GateReportSchema.parse(report)).toEqual(report)
		expect(events).toHaveLength(2)
	})

	it('Prices only the gates still to come, so the floor shrinks as the chain advances', async () => {
		const { ports, calls } = createPorts()
		// A run-9-shaped chain: 1.7M up front, acceptance-tests takes 1.1M of it, review 250k
		let left = 1_700_000
		// Replacing the implementation drops createPorts' recorder, so `calls` is pushed by hand
		const spend = (port: 'acceptanceTests' | 'review', name: string, tokens: number) =>
			vi.mocked(ports[port]).mockImplementation(async ({ onUsage }) => {
				calls.push(name)
				left -= tokens
				onUsage({ inputTokens: tokens, outputTokens: 0 })
				return green(name)
			})
		spend('acceptanceTests', 'acceptance-tests', 1_100_000)
		spend('review', 'review', 250_000)
		const result = await run(ports, {
			budget: { ...gateBudgetFor(9_000_000), remaining: () => left },
		}).outcome

		// review starts with 600k left — far under the 1.4M a whole chain needs, but its own
		// remaining slice (review + acceptance-check ≈ 294k) fits
		expect(result.ok).toBe(true)
		expect(calls).toEqual([...gateOrder])
	})

	it('Holds the delivery reserve back from the chain', async () => {
		const { ports } = createPorts()
		// 1.4M chain + a 250k delivery reserve: 1.5M is not enough, 1.7M is
		expect((await run(ports, withBudget(1_500_000)).outcome).exhausted).toBe('acceptance-tests')
		expect((await run(ports, withBudget(1_700_000)).outcome).exhausted).toBeUndefined()
	})

	it('Stops a runaway gate at its allowance and reports it red instead of aborting the job', async () => {
		const jobSignal = new AbortController()
		let seen: AbortSignal | undefined
		const { ports } = createPorts()
		// Spends past the 2.25M allowance (25 % of 9M) in two samples, then keeps insisting it is fine
		vi.mocked(ports.acceptanceTests).mockImplementation(async ({ signal, onUsage }) => {
			seen = signal
			onUsage({ inputTokens: 2_000_000, outputTokens: 0 })
			onUsage({ inputTokens: 1_000_000, outputTokens: 0 })
			return green('all criteria covered')
		})
		const result = await run(ports, {
			...withBudget(9_000_000),
			signal: jobSignal.signal,
		}).outcome

		expect(result.ok).toBe(false)
		expect(result.failed).toEqual(['acceptance-tests'])
		expect(result.exhausted).toBeUndefined()
		const report = result.reports.at(-1)!
		expect(report.summary).toBe('stopped at its token allowance (3.0M of 2.3M)')
		expect(report.tokens).toBe(3_000_000)
		// The gate's own signal was aborted; the job's was left alone
		expect(seen?.aborted).toBe(true)
		expect(jobSignal.signal.aborted).toBe(false)
	})

	it('Scales the guard rails down with the budget so a small job still runs its gates', async () => {
		const { ports, calls } = createPorts()
		const tiny = { budget: { ...gateBudgetFor(10_000), remaining: () => 10_000 } }
		const result = await run(ports, tiny).outcome

		expect(result.ok).toBe(true)
		expect(calls).toEqual([...gateOrder])
	})

	it('Runs unmetered when no budget is supplied (gates-demo)', async () => {
		const { ports, calls } = createPorts()
		const result = await run(ports).outcome

		expect(result.ok).toBe(true)
		expect(result.exhausted).toBeUndefined()
		expect(calls).toEqual([...gateOrder])
	})
})

describe('gateBudgetFor', () => {
	it('Uses the measured costs when the budget is large enough to carry them', () => {
		expect(gateBudgetFor(9_000_000)).toEqual({
			reserve: 250_000,
			chainReserve: 1_400_000,
			allowancePerGate: 2_250_000,
		})
	})

	it('Clamps every rail to a share of a small budget', () => {
		expect(gateBudgetFor(1_000_000)).toEqual({
			reserve: 50_000,
			chainReserve: 250_000,
			allowancePerGate: 250_000,
		})
	})
})

describe('failureNotification', () => {
	it('Builds a schema-valid admin notification listing the gates', () => {
		const payload = failureNotification('job-1', 'failed', 'gates failed', [
			{
				name: 'verify',
				ok: true,
				startedAt: new Date(0).toISOString(),
				durationMs: 1500,
				tokens: 0,
				summary: 'ok',
			},
			{
				name: 'review',
				ok: false,
				startedAt: new Date(0).toISOString(),
				durationMs: 60_000,
				tokens: 4200,
				summary: 'open high finding',
			},
		])

		expect(NotifyPayloadSchema.parse(payload)).toEqual(payload)
		expect(payload.subject).toBe('Build job job-1 failed')
		expect(payload.text).toContain('- verify: ok (0 tokens, 2 s)')
		expect(payload.text).toContain('- review: FAILED (4200 tokens, 60 s)')
		// The api holds exactly this mail for a job it is about to auto-retry
		expect(payload.kind).toBe('job-failed')
	})

	it('Says so when no gate ran', () => {
		expect(failureNotification('j', 'killed', undefined, []).text).toContain('- no gate ran')
	})

	it('Marks only a FAILED job for the auto-retry mail hold — an admin kill is never retried', () => {
		expect(failureNotification('j', 'killed', undefined, []).kind).toBeUndefined()
	})
})

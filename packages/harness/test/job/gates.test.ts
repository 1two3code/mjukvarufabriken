import { GateReportSchema, NotifyPayloadSchema } from '@mf/models'

import { failureNotification, gateOrder, gatesFailedReason, runGates } from '#job/gates.ts'

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
			'acceptance-check',
		])
		expect(events.map(e => e.type)).toEqual(['gate', 'gate', 'gate', 'gate'])
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
	})

	it('Says so when no gate ran', () => {
		expect(failureNotification('j', 'killed', undefined, []).text).toContain('- no gate ran')
	})
})

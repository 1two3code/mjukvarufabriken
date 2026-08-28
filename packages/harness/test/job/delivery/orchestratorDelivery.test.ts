import { runJob } from '#job/orchestrator.ts'

import type { Deliverable, NewJobEvent, Plan, Spec } from '@mf/models'
import type { OrchestratorPorts } from '#job/types.ts'

const spec: Spec = { goal: 'x', users: [], features: [], nonGoals: [], stackConstraints: [] }
const plan: Plan = {
	summary: 'one',
	tasks: [
		{ id: 'a', title: 'a', description: 'a', dependsOn: [], areas: [], acceptanceCriteriaIds: [] },
	],
}

const deliverable: Deliverable = {
	jobId: 'job-1',
	repositoryUrl: 'https://github.com/mjukvaruhuset/gym',
	transferPending: false,
	deployUrl: 'https://x.eu-north-1.on.aws',
	siteUrl: null,
	deliverableKey: 'deliverables/job-1/',
	files: [],
	deliveredAt: '2026-08-26T12:00:00.000Z',
}

const createPorts = (deliver: OrchestratorPorts['deliver']): OrchestratorPorts => ({
	plan: async () => plan,
	runTask: async ({ task }) => ({ ok: true, tokens: 10, branch: `task/${task.id}` }),
	mergeTask: async () => ({ ok: true, tokens: 0 }),
	verify: async () => ({ ok: true, output: 'green' }),
	acceptanceTests: async () => ({ ok: true, tokens: 0, summary: 'ok' }),
	review: async () => ({ ok: true, tokens: 0, summary: 'ok' }),
	licence: async () => ({ ok: true, tokens: 0, summary: 'ok' }),
	acceptanceCheck: async () => ({ ok: true, tokens: 0, summary: 'ok' }),
	deliver,
})

const run = async (ports: OrchestratorPorts, withTarget = true) => {
	const events: NewJobEvent[] = []
	const outcome = await runJob(
		{
			id: 'job-1',
			spec,
			repoDir: '/tmp/repo',
			budget: { maxTokens: 1_000_000, maxDurationMinutes: 60, maxWorkers: 1 },
			delivery: withTarget ? { slug: 'gym', appName: 'Gym' } : undefined,
		},
		{
			ports,
			hooks: {
				emit: async event => {
					events.push(event)
				},
				pollIntervalMs: 1_000_000,
			},
		}
	)
	return { outcome, events }
}

describe('runJob delivery step', () => {
	it('Delivers after green gates and reports the deliverable in the done event', async () => {
		// Arrange
		const deliver = vi.fn(async ({ emit, onUsage }) => {
			onUsage({ inputTokens: 300, outputTokens: 0 })
			await emit({ type: 'delivery', payload: { step: 'bundle', ok: true } })
			return { ok: true, tokens: 300, deliverable, steps: [] }
		})

		// Act
		const { outcome, events } = await run(createPorts(deliver))

		// Assert
		expect(outcome.status).toBe('delivered')
		expect(outcome.deliverable).toEqual(deliverable)
		expect(outcome.tokensUsed).toBe(300)
		expect(deliver).toHaveBeenCalledWith(
			expect.objectContaining({
				jobId: 'job-1',
				plan,
				target: { slug: 'gym', appName: 'Gym' },
				gates: expect.arrayContaining([expect.objectContaining({ name: 'verify' })]),
			})
		)
		expect(events.map(event => event.type).slice(-2)).toEqual(['delivery', 'done'])
		expect(events.at(-1)?.payload).toEqual({
			tokensUsed: 300,
			repositoryUrl: deliverable.repositoryUrl,
			deployUrl: deliverable.deployUrl,
		})
	})

	it('Fails the job (and notifies) when delivery fails', async () => {
		// Arrange
		const ports = createPorts(async () => ({
			ok: false,
			tokens: 0,
			reason: 'github: push failed',
			steps: [],
		}))

		// Act
		const { outcome, events } = await run(ports)

		// Assert
		expect(outcome.status).toBe('failed')
		expect(outcome.reason).toBe('delivery failed: github: push failed')
		expect(outcome.deliverable).toBeUndefined()
		expect(events.map(event => event.type).slice(-2)).toEqual(['failed', 'notify'])
	})

	it('Treats a throwing delivery port as a failure', async () => {
		const ports = createPorts(async () => {
			throw new Error('boom')
		})
		const { outcome } = await run(ports)
		expect(outcome).toMatchObject({ status: 'failed', reason: 'delivery failed: boom' })
	})

	it('Skips delivery without a target or a port', async () => {
		// Arrange
		const deliver = vi.fn()

		// Act
		const noTarget = await run(createPorts(deliver), false)
		const noPort = await run(createPorts(undefined))

		// Assert
		expect(deliver).not.toHaveBeenCalled()
		expect(noTarget.outcome.status).toBe('delivered')
		expect(noPort.outcome.status).toBe('delivered')
		expect(noTarget.outcome.deliverable).toBeUndefined()
	})
})


// MARK: Approve-before-deliver hold (W9)

type ApprovalHooks = {
	approveBeforeDeliver?: boolean
	withTarget?: boolean
	isApproved?: () => Promise<boolean>
	isKilled?: () => Promise<boolean>
	pollIntervalMs?: number
}

const okDeliver = () =>
	vi.fn(async ({ emit }) => {
		await emit({ type: 'delivery', payload: { step: 'bundle', ok: true } })
		return { ok: true, tokens: 0, deliverable, steps: [] }
	})

const runWithApproval = async (deliver: OrchestratorPorts['deliver'], hooks: ApprovalHooks) => {
	const events: NewJobEvent[] = []
	const onAwaitingApproval = vi.fn(async () => {})
	const outcome = await runJob(
		{
			id: 'job-1',
			spec,
			repoDir: '/tmp/repo',
			budget: { maxTokens: 1_000_000, maxDurationMinutes: 60, maxWorkers: 1 },
			delivery: hooks.withTarget === false ? undefined : { slug: 'gym', appName: 'Gym' },
			approveBeforeDeliver: hooks.approveBeforeDeliver,
		},
		{
			ports: createPorts(deliver),
			hooks: {
				emit: async event => {
					events.push(event)
				},
				onAwaitingApproval,
				isApproved: hooks.isApproved,
				isKilled: hooks.isKilled,
				pollIntervalMs: hooks.pollIntervalMs ?? 1_000_000,
			},
		}
	)
	return { outcome, events, onAwaitingApproval }
}

describe('runJob approve-before-deliver hold', () => {
	it('Holds after green gates, then delivers once approved', async () => {
		// Arrange: not approved on the first poll, approved on the second
		const isApproved = vi.fn()
		isApproved.mockResolvedValueOnce(false).mockResolvedValue(true)
		const deliver = okDeliver()

		// Act
		const { outcome, events, onAwaitingApproval } = await runWithApproval(deliver, {
			approveBeforeDeliver: true,
			isApproved,
			pollIntervalMs: 1,
		})

		// Assert: the hold fired before delivery, and delivery still happened
		expect(onAwaitingApproval).toHaveBeenCalledTimes(1)
		expect(isApproved.mock.calls.length).toBeGreaterThanOrEqual(2)
		expect(deliver).toHaveBeenCalledOnce()
		expect(outcome.status).toBe('delivered')
		expect(outcome.deliverable).toEqual(deliverable)
		const types = events.map(event => event.type)
		const holdAt = types.indexOf('log')
		const deliveredAt = types.indexOf('delivery')
		expect(holdAt).toBeGreaterThanOrEqual(0)
		expect(holdAt).toBeLessThan(deliveredAt)
		expect(events[holdAt]?.payload).toMatchObject({ phase: 'awaiting_approval' })
	})

	it('Does not deliver while unapproved; a kill during the hold ends the job', async () => {
		// Arrange: never approved, kill flips true on the background poll
		const deliver = okDeliver()

		// Act
		const { outcome } = await runWithApproval(deliver, {
			approveBeforeDeliver: true,
			isApproved: async () => false,
			isKilled: async () => true,
			pollIntervalMs: 2,
		})

		// Assert
		expect(deliver).not.toHaveBeenCalled()
		expect(outcome.status).toBe('killed')
		expect(outcome.deliverable).toBeUndefined()
	})

	it('Auto-delivers unchanged when the flag is off (no hold, no approval poll)', async () => {
		// Arrange
		const deliver = okDeliver()
		const isApproved = vi.fn(async () => true)

		// Act
		const { outcome, events, onAwaitingApproval } = await runWithApproval(deliver, {
			approveBeforeDeliver: false,
			isApproved,
		})

		// Assert
		expect(onAwaitingApproval).not.toHaveBeenCalled()
		expect(isApproved).not.toHaveBeenCalled()
		expect(deliver).toHaveBeenCalledOnce()
		expect(outcome.status).toBe('delivered')
		expect(events.some(event => event.type === 'log')).toBe(false)
	})

	it('Skips the hold when there is nothing to deliver even with the flag on', async () => {
		// Arrange: flag on but no delivery target — the job ends at the gates, never pausing
		const deliver = okDeliver()
		const isApproved = vi.fn(async () => false)

		// Act
		const { outcome, onAwaitingApproval } = await runWithApproval(deliver, {
			approveBeforeDeliver: true,
			withTarget: false,
			isApproved,
		})

		// Assert
		expect(onAwaitingApproval).not.toHaveBeenCalled()
		expect(isApproved).not.toHaveBeenCalled()
		expect(deliver).not.toHaveBeenCalled()
		expect(outcome.status).toBe('delivered')
	})
})

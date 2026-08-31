import {
	deadJobReason,
	jobSweepMinTaskAgeMs,
	neverLaunchedReason,
	runJobSweep,
} from '#/lib/jobSweep.ts'

import type { FastifyInstance } from 'fastify'
import type { Job } from '@mf/models'
import type { TaskState } from '#/plugins/ecs.ts'

const job = (id: string, overrides: Partial<Job> = {}): Job => ({
	id,
	orderId: `order-${id}`,
	orgId: 'org-1',
	status: 'queued',
	spec: {
		goal: 'g',
		users: [],
		features: [],
		nonGoals: [],
		stackConstraints: [],
		sizeClass: 'S',
	},
	budget: { maxTokens: 1, maxWorkers: 1, maxDurationMinutes: 1 },
	tokensUsed: 0,
	taskArn: `arn:task/${id}`,
	createdAt: '2026-08-26T12:00:00.000Z',
	...overrides,
})

/** The slice of the app `runJobSweep` touches: ecs + the jobs repository + logger */
const createApp = (options: {
	configured?: boolean
	candidates?: Job[]
	states?: Map<string, TaskState>
	/** The row `db.jobs.get` returns for a re-read (defaults to the candidate itself) */
	current?: (id: string) => Job | undefined
	/** `db.jobs.update` returns undefined to model the killed-guard refusing the write */
	updateRefusesFor?: Set<string>
}) => {
	const candidates = options.candidates ?? []
	const byId = new Map(candidates.map(candidate => [candidate.id, candidate]))
	const get = vi.fn((id: string) =>
		Promise.resolve(options.current ? options.current(id) : byId.get(id))
	)
	const update = vi.fn((id: string, patch: Partial<Job>) =>
		Promise.resolve(options.updateRefusesFor?.has(id) ? undefined : { ...byId.get(id)!, ...patch })
	)
	const listStuck = vi.fn().mockResolvedValue(candidates)
	const appendEvent = vi.fn().mockResolvedValue(undefined)
	const describeTasks = vi.fn().mockResolvedValue(options.states ?? new Map())
	const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
	const send = vi.fn().mockResolvedValue(undefined)
	const recordJobFailed = vi.fn().mockResolvedValue(undefined)
	const app = {
		ecs: { configured: options.configured ?? true, describeTasks },
		db: { jobs: { listStuck, get, update, appendEvent } },
		email: { send },
		metrics: { recordJobFailed },
		secrets: { env: 'test', authAdminEmails: ['ops@example.com'] },
		log,
	}
	return {
		app: app as unknown as FastifyInstance,
		listStuck,
		get,
		update,
		appendEvent,
		describeTasks,
		send,
		recordJobFailed,
		log,
	}
}

describe('runJobSweep', () => {
	it('Does nothing when ECS is unconfigured — no task was ever launched', async () => {
		// Arrange
		const { app, listStuck, describeTasks } = createApp({ configured: false })

		// Act
		const result = await runJobSweep(app)

		// Assert
		expect(result).toEqual({ checked: 0, failed: 0 })
		expect(listStuck).not.toHaveBeenCalled()
		expect(describeTasks).not.toHaveBeenCalled()
	})

	it('Lists stuck jobs with an age floor and describes only their tasks', async () => {
		// Arrange
		const before = Date.now()
		const { app, listStuck, describeTasks } = createApp({ candidates: [job('a')] })

		// Act
		await runJobSweep(app)

		// Assert: the cutoff is roughly now minus the min task age
		const cutoff = listStuck.mock.calls[0]![0] as Date
		expect(cutoff.getTime()).toBeLessThanOrEqual(before - jobSweepMinTaskAgeMs + 5)
		expect(cutoff.getTime()).toBeGreaterThan(before - jobSweepMinTaskAgeMs - 60_000)
		expect(describeTasks).toHaveBeenCalledWith(['arn:task/a'])
	})

	it('Fails a job whose task ECS reports STOPPED and records the reason', async () => {
		// Arrange
		const states = new Map([['arn:task/a', { lastStatus: 'STOPPED', stoppedReason: 'exit 1' }]])
		const { app, update, appendEvent } = createApp({ candidates: [job('a')], states })

		// Act
		const result = await runJobSweep(app)

		// Assert
		expect(result).toEqual({ checked: 1, failed: 1 })
		expect(update).toHaveBeenCalledWith('a', {
			status: 'failed',
			reason: 'build task stopped (STOPPED): exit 1',
			finishedAt: expect.any(Date),
			reportTokenHash: null,
		})
		expect(appendEvent).toHaveBeenCalledWith('a', {
			type: 'failed',
			payload: { reason: 'build task stopped (STOPPED): exit 1', sweep: true },
		})
	})

	it('Fails a job whose task ECS no longer knows about (aged out / gone)', async () => {
		// Arrange: describe returns an empty map — the task is absent
		const { app, update } = createApp({ candidates: [job('a')], states: new Map() })

		// Act
		const result = await runJobSweep(app)

		// Assert
		expect(result).toEqual({ checked: 1, failed: 1 })
		expect(update).toHaveBeenCalledWith(
			'a',
			expect.objectContaining({
				status: 'failed',
				reason: 'build task gone from ECS before the job finished',
			})
		)
	})

	it('Leaves a job whose task is still RUNNING untouched', async () => {
		// Arrange
		const states = new Map([['arn:task/a', { lastStatus: 'RUNNING' }]])
		const { app, update, appendEvent } = createApp({ candidates: [job('a')], states })

		// Act
		const result = await runJobSweep(app)

		// Assert
		expect(result).toEqual({ checked: 1, failed: 0 })
		expect(update).not.toHaveBeenCalled()
		expect(appendEvent).not.toHaveBeenCalled()
	})

	it('Is idempotent: a job that finished between the list and the write is not failed', async () => {
		// Arrange: the re-read shows the job already delivered
		const { app, update, appendEvent } = createApp({
			candidates: [job('a')],
			states: new Map(),
			current: () => job('a', { status: 'delivered' }),
		})

		// Act
		const result = await runJobSweep(app)

		// Assert
		expect(result).toEqual({ checked: 1, failed: 0 })
		expect(update).not.toHaveBeenCalled()
		expect(appendEvent).not.toHaveBeenCalled()
	})

	it('Lets an admin kill win: a refused status write does not count or emit an event', async () => {
		// Arrange: the killed-guard makes db.jobs.update return undefined
		const { app, appendEvent } = createApp({
			candidates: [job('a')],
			states: new Map(),
			updateRefusesFor: new Set(['a']),
		})

		// Act
		const result = await runJobSweep(app)

		// Assert
		expect(result).toEqual({ checked: 1, failed: 0 })
		expect(appendEvent).not.toHaveBeenCalled()
	})

	it('Fails a job with NO recorded task on age alone, without asking ECS', async () => {
		// Arrange: listStuck only surfaces a null-arn job once its whole wall-clock budget passed
		const { app, update, appendEvent, describeTasks } = createApp({
			candidates: [job('a', { taskArn: undefined })],
		})

		// Act
		const result = await runJobSweep(app)

		// Assert: failed with the never-launched reason, and no empty DescribeTasks call was made
		expect(result).toEqual({ checked: 1, failed: 1 })
		expect(describeTasks).not.toHaveBeenCalled()
		expect(update).toHaveBeenCalledWith(
			'a',
			expect.objectContaining({ status: 'failed', reason: neverLaunchedReason })
		)
		expect(appendEvent).toHaveBeenCalledWith('a', {
			type: 'failed',
			payload: { reason: neverLaunchedReason, sweep: true },
		})
	})

	it('Offers every job it fails to the demo auto-retry when jobService is present', async () => {
		// Arrange
		const { app, update } = createApp({ candidates: [job('a', { taskArn: undefined })] })
		const retryFailedBuild = vi.fn().mockResolvedValue(undefined)
		Object.assign(app, { jobService: { retryFailedBuild } })

		// Act
		await runJobSweep(app)

		// Assert: the retry gets the FAILED row (the update result), not the stale candidate
		expect(retryFailedBuild).toHaveBeenCalledTimes(1)
		expect(retryFailedBuild).toHaveBeenCalledWith(await update.mock.results[0]!.value)
		expect(retryFailedBuild.mock.calls[0]![0]).toMatchObject({ id: 'a', status: 'failed' })
	})

	it('A throwing auto-retry never breaks the sweep', async () => {
		// Arrange
		const { app, send } = createApp({ candidates: [job('a'), job('b')], states: new Map() })
		const retryFailedBuild = vi.fn().mockRejectedValue(new Error('ecs down'))
		Object.assign(app, { jobService: { retryFailedBuild } })

		// Act
		const result = await runJobSweep(app)

		// Assert: both jobs still failed, both retries attempted; no sweep mail on top — a
		// throwing retryFailedBuild has already mailed for every post-candidacy failure itself
		expect(result).toEqual({ checked: 2, failed: 2 })
		expect(retryFailedBuild).toHaveBeenCalledTimes(2)
		expect(send).not.toHaveBeenCalled()
	})

	it('Records the JobsFailed metric for every job it fails — the container never reported it', async () => {
		// Arrange
		const { app, recordJobFailed } = createApp({
			candidates: [job('a'), job('b', { taskArn: undefined })],
			states: new Map(),
		})

		// Act
		await runJobSweep(app)

		// Assert
		expect(recordJobFailed).toHaveBeenCalledTimes(2)
		expect(recordJobFailed).toHaveBeenCalledWith('a')
		expect(recordJobFailed).toHaveBeenCalledWith('b')
	})

	it('Mails the admins for a failed job with no retry started — the last chance anyone hears of it', async () => {
		// Arrange: retryFailedBuild declines (not a candidate: an M job, or a dead retry attempt
		// whose first failure's mail was HELD) — without the sweep mail the build vanishes silently
		const { app, send } = createApp({ candidates: [job('a')], states: new Map() })
		const retryFailedBuild = vi.fn().mockResolvedValue(undefined)
		Object.assign(app, { jobService: { retryFailedBuild } })

		// Act
		await runJobSweep(app)

		// Assert
		expect(send).toHaveBeenCalledWith(
			expect.objectContaining({
				to: 'ops@example.com',
				subject: expect.stringContaining('failed (liveness sweep)'),
				text: expect.stringContaining('build task gone from ECS'),
			})
		)
	})

	it('Sends NO sweep mail when the retry launched — the rebuild outcome pages instead', async () => {
		// Arrange
		const { app, send } = createApp({ candidates: [job('a')], states: new Map() })
		const retryFailedBuild = vi.fn().mockResolvedValue(job('retry-1'))
		Object.assign(app, { jobService: { retryFailedBuild } })

		// Act
		await runJobSweep(app)

		// Assert
		expect(send).not.toHaveBeenCalled()
	})

	it('Fails only the dead jobs of a mixed batch', async () => {
		// Arrange
		const states = new Map([
			['arn:task/a', { lastStatus: 'RUNNING' }],
			['arn:task/b', { lastStatus: 'STOPPED' }],
			// c is absent → gone → dead
		])
		const { app, update } = createApp({
			candidates: [job('a'), job('b'), job('c')],
			states,
		})

		// Act
		const result = await runJobSweep(app)

		// Assert
		expect(result).toEqual({ checked: 3, failed: 2 })
		const failedIds = update.mock.calls.map(([id]) => id)
		expect(failedIds).toEqual(['b', 'c'])
	})
})

describe('deadJobReason', () => {
	it('Names the last status and, when present, the stopped reason', () => {
		expect(deadJobReason({ lastStatus: 'STOPPED', stoppedReason: 'OOM' })).toBe(
			'build task stopped (STOPPED): OOM'
		)
		expect(deadJobReason({ lastStatus: 'STOPPED' })).toBe('build task stopped (STOPPED)')
		expect(deadJobReason(undefined)).toBe('build task gone from ECS before the job finished')
	})
})

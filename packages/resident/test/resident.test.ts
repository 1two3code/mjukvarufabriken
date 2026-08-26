import { auditKey } from '#/audit.ts'
import { monthKey } from '#/cap.ts'
import { createFakeUsageReporter } from '#/factory.ts'
import { createFakeGitHub } from '#/github.ts'
import { usageKey } from '#/metering.ts'
import { createFakeWorkspace, createResident, pausedKey } from '#/resident.ts'
import { createMemoryObjectStore } from '#/store.ts'

import type { OrchestratorPorts } from '@mf/harness'
import type { Plan } from '@mf/models'
import type { ResidentIssue } from '#/github.ts'

// MARK: Fixtures

const noon = Date.parse('2026-09-03T12:00:00.000Z')

const plan: Plan = {
	summary: 'one step',
	tasks: [
		{
			id: 'step-1',
			title: 'Implement',
			description: 'do it',
			dependsOn: [],
			areas: ['apps/app'],
			acceptanceCriteriaIds: ['f0.c0'],
		},
	],
}

type FakePortOptions = {
	/** Tokens each worker task reports (budget-weighted) */
	taskTokens?: number
	fail?: 'task' | 'gate'
	/** Hold every worker task until released (to test the pause switch mid-task) */
	hold?: boolean
}

const createFakePorts = ({ taskTokens = 1000, fail, hold = false }: FakePortOptions = {}) => {
	let release: () => void = () => {}
	const held = new Promise<void>(resolve => (release = resolve))
	const ports: OrchestratorPorts = {
		plan: vi.fn(async ({ onUsage }) => {
			onUsage({ inputTokens: 300, outputTokens: 200 })
			return plan
		}),
		runTask: vi.fn(async ({ task, onUsage, signal }) => {
			if (hold) {
				await Promise.race([
					held,
					new Promise(resolve => signal.addEventListener('abort', resolve)),
				])
			}
			onUsage({ inputTokens: taskTokens, outputTokens: 0 })
			if (fail === 'task')
				return { ok: false, tokens: taskTokens, branch: `task/${task.id}`, reason: 'boom' }
			return { ok: true, tokens: taskTokens, branch: `task/${task.id}` }
		}),
		mergeTask: vi.fn(async () => ({ ok: true, tokens: 0 })),
		verify: vi.fn(async () => ({ ok: true, output: 'green' })),
		acceptanceTests: vi.fn(async () => ({ ok: true, tokens: 0, summary: 'tests green' })),
		review: vi.fn(async ({ onUsage }) => {
			onUsage({ inputTokens: 50, outputTokens: 0 })
			return {
				ok: fail !== 'gate',
				tokens: 50,
				summary: fail === 'gate' ? '1 high finding' : 'no findings',
			}
		}),
		acceptanceCheck: vi.fn(async () => ({ ok: true, tokens: 0, summary: 'all met' })),
	}
	return { ports, release: () => release() }
}

const issue = (number: number, labels = ['resident']): ResidentIssue => ({
	number,
	title: `Issue ${number}`,
	body: `Body ${number}\n- [ ] criterion`,
	labels,
})

type SetupOptions = FakePortOptions & {
	issues?: ResidentIssue[]
	monthlyTokens?: number
	taskTokens?: number
	pausedByEnv?: boolean
}

const setup = ({
	issues = [],
	monthlyTokens = 100_000,
	pausedByEnv,
	...portOptions
}: SetupOptions = {}) => {
	const store = createMemoryObjectStore()
	const github = createFakeGitHub(issues)
	const fake = createFakePorts(portOptions)
	const usageReporter = createFakeUsageReporter()
	const workspace = createFakeWorkspace(['src/search.ts', 'src/search.test.ts'])
	let now = noon
	const resident = createResident({
		installationId: 'acme',
		repository: 'acme/shop',
		store,
		github,
		ports: fake.ports,
		usageReporter,
		workspace,
		monthlyTokens,
		task: { maxTokens: 10_000, maxDurationMinutes: 60, maxWorkers: 2 },
		pausedByEnv,
		planModel: 'claude-opus-4-1',
		workerModel: 'claude-sonnet-5',
		killPollMs: 5,
		now: () => now,
		log: () => {},
	})
	const auditTypes = async (day = '2026-09-03') =>
		(await resident.audit.read(day)).map(entry => entry.type)
	return {
		store,
		github,
		ports: fake.ports,
		release: fake.release,
		usageReporter,
		workspace,
		resident,
		auditTypes,
		advance: (ms: number) => (now += ms),
	}
}

// MARK: Tests

describe('resident', () => {
	it('Builds a labelled issue into a pull request and audits every step', async () => {
		// Arrange
		const { resident, github, workspace, auditTypes, ports } = setup({ issues: [issue(7)] })
		await resident.start()

		// Act
		const added = await resident.pollIssues()
		const built = await resident.runNext()

		// Assert
		expect(added).toHaveLength(1)
		expect(built).toBe(added[0])
		expect(built).toMatchObject({
			status: 'done',
			issueNumber: 7,
			tokensUsed: 1550,
			pullRequestUrl: 'https://github.com/acme/shop/pull/1',
		})
		// The spec handed to the planner comes from the issue
		expect(vi.mocked(ports.plan).mock.calls[0]![0].spec.features[0]!.acceptanceCriteria).toEqual([
			'criterion',
		])
		expect(github.pushes).toEqual([
			{ repoDir: `/tmp/resident/${built!.id}/repo`, branch: `resident/${built!.id}` },
		])
		expect(github.pullRequests[0]).toMatchObject({
			head: `resident/${built!.id}`,
			base: 'main',
			title: 'Issue 7',
		})
		expect(github.pullRequests[0]!.body).toContain('Closes #7.')
		expect(github.pullRequests[0]!.body).toContain('`src/search.ts`')
		expect(github.issues[0]!.labels).toEqual(['resident', 'resident:done'])
		expect(github.comments).toEqual([
			{ issueNumber: 7, body: 'Pull request opened: https://github.com/acme/shop/pull/1' },
		])
		expect(workspace.cleaned).toEqual([built!.id])
		expect(await auditTypes()).toEqual([
			'resident_started',
			'task_queued',
			'task_started',
			'planned',
			'tokens',
			'worker',
			'worker',
			'worker',
			'tokens',
			'command_run',
			'gate',
			'gate',
			'gate',
			'gate',
			'tokens',
			'files_changed',
			'pr_opened',
			'task_finished',
		])
		// Polling again does not queue the same issue twice
		expect(await resident.pollIssues()).toEqual([])
		expect((await resident.status()).queued).toBe(0)
	})

	it('Audit entries carry what the action did', async () => {
		const { resident, auditTypes } = setup({ issues: [issue(7)] })
		await resident.start()
		await resident.pollIssues()
		const task = await resident.runNext()
		const entries = await resident.audit.read('2026-09-03')
		expect(await auditTypes()).toContain('gate')
		expect(entries.find(entry => entry.type === 'files_changed')).toEqual({
			time: '2026-09-03T12:00:00.000Z',
			type: 'files_changed',
			taskId: task!.id,
			detail: { count: 2, files: ['src/search.ts', 'src/search.test.ts'] },
		})
		expect(entries.find(entry => entry.type === 'command_run')?.detail).toEqual({
			commands: ['npm run lint', 'npm test'],
			ok: true,
			summary: 'lint + test green',
		})
		expect(entries.filter(entry => entry.type === 'gate').map(entry => entry.detail.name)).toEqual([
			'verify',
			'acceptance-tests',
			'review',
			'acceptance-check',
		])
		expect(entries.at(-1)).toMatchObject({
			type: 'task_finished',
			detail: { tokens: 1550, pullRequestUrl: 'https://github.com/acme/shop/pull/1', files: 2 },
		})
	})

	it('Marks a task failed (no PR, issue labelled) when a gate is red', async () => {
		const { resident, github, auditTypes } = setup({ issues: [issue(3)], fail: 'gate' })
		await resident.start()
		await resident.pollIssues()
		const task = await resident.runNext()

		expect(task).toMatchObject({ status: 'failed' })
		expect(task!.reason).toContain('review: 1 high finding')
		expect(github.pullRequests).toEqual([])
		expect(github.issues[0]!.labels).toEqual(['resident', 'resident:failed'])
		expect(github.comments[0]!.body).toContain('could not complete this task')
		expect(await auditTypes()).toContain('task_failed')
		expect(await auditTypes()).not.toContain('pr_opened')
	})

	it('Enforces the monthly cap: the task budget is what the month has left, and nothing starts once it is spent', async () => {
		// Arrange: a 2000-token month, tasks that burn ~1550 each
		const { resident, store, ports, auditTypes } = setup({ monthlyTokens: 2000 })
		await resident.start()
		await resident.addTask({ title: 'First', description: 'one' })
		await resident.addTask({ title: 'Second', description: 'two' })

		// Act
		const first = await resident.runNext()
		const second = await resident.runNext()
		const third = await resident.runNext()

		// Assert: the first task ran with the full month, the second with the remainder (and aborted)
		expect(first!.status).toBe('done')
		// 1550 for the first task + the planner turn (500) that crossed the second's 450 budget:
		// the cap overshoots by at most one in-flight model turn
		expect(JSON.parse(store.objects.get(monthKey('2026-09'))!).usedTokens).toBe(2050)
		expect(vi.mocked(ports.plan)).toHaveBeenCalledTimes(2)
		expect(second!.status).toBe('failed')
		expect(second!.reason).toBe('budget exceeded')
		const status = await resident.status()
		expect(status.monthlyCap.reached).toBe(true)
		expect(status.monthlyCap.remainingTokens).toBe(0)
		expect(third).toBeUndefined()
		expect(await auditTypes()).toContain('cap_reached')
		// The second task never got a budget above what was left
		const secondBudget = (await resident.audit.read('2026-09-03')).filter(
			entry => entry.type === 'task_started'
		)[1]!.detail.budgetTokens
		expect(secondBudget).toBe(450)
	})

	it('Does nothing while paused, persists the flag, and resumes', async () => {
		const { resident, store, ports, auditTypes } = setup()
		await resident.start()
		await resident.addTask({ title: 'Later', description: 'x' })

		expect(await resident.pause('api')).toBe(true)
		expect(await resident.runNext()).toBeUndefined()
		expect(vi.mocked(ports.plan)).not.toHaveBeenCalled()
		expect(JSON.parse(store.objects.get(pausedKey)!)).toMatchObject({ paused: true })
		expect((await resident.status()).paused).toBe(true)

		expect(await resident.resume('api')).toBe(false)
		expect((await resident.runNext())?.status).toBe('done')
		expect(await auditTypes()).toEqual(
			expect.arrayContaining(['paused', 'resumed', 'task_finished'])
		)
	})

	it('Starts paused when the stored flag says so (survives a restart) or RESIDENT_PAUSED is set', async () => {
		const stored = createMemoryObjectStore()
		await stored.put(pausedKey, JSON.stringify({ paused: true }))
		const byStore = createResident({
			installationId: 'acme',
			repository: 'acme/shop',
			store: stored,
			github: createFakeGitHub(),
			ports: createFakePorts().ports,
			usageReporter: createFakeUsageReporter(),
			workspace: createFakeWorkspace(),
			monthlyTokens: 1,
			task: { maxTokens: 1, maxDurationMinutes: 1, maxWorkers: 1 },
			now: () => noon,
			log: () => {},
		})
		await byStore.start()
		expect(byStore.paused).toBe(true)

		const { resident: byEnv } = setup({ pausedByEnv: true })
		await byEnv.start()
		expect(byEnv.paused).toBe(true)
	})

	it('Pausing aborts the task in flight (the pause button is the kill switch)', async () => {
		const { resident, github } = setup({ hold: true })
		await resident.start()
		await resident.addTask({ title: 'Long', description: 'x' })

		const run = resident.runNext()
		while (!(await resident.status()).running) await new Promise(resolve => setTimeout(resolve, 1))
		await resident.pause('api')
		const task = await run

		expect(task).toMatchObject({ status: 'failed', reason: 'killed' })
		expect(github.pullRequests).toEqual([])
		expect((await resident.status()).running).toBeUndefined()
	})

	it('Writes the day record to the store and reports it to the factory with cost × 1.5', async () => {
		const { resident, store, usageReporter, auditTypes } = setup()
		await resident.start()
		await resident.addTask({ title: 'Task', description: 'x' })
		await resident.runNext()

		await resident.flushUsage()

		const record = JSON.parse(store.objects.get(usageKey('2026-09-03'))!)
		expect(usageReporter.records).toEqual([record])
		expect(record).toMatchObject({
			installationId: 'acme',
			repository: 'acme/shop',
			day: '2026-09-03',
			month: '2026-09',
			totalTokens: 1550,
			tasks: { started: 1, succeeded: 1, failed: 0, pullRequestsOpened: 1 },
			monthlyCap: { tokens: 100_000, usedTokens: 1550 },
		})
		// planner: 300 in + 200 out on opus (0.0045 + 0.015); workers: 1050 in on sonnet (0.00315)
		expect(record.tokensByModel['claude-opus-4-1']).toMatchObject({
			inputTokens: 300,
			outputTokens: 200,
			budgetTokens: 500,
		})
		expect(record.tokensByModel['claude-sonnet-5']).toMatchObject({
			inputTokens: 1050,
			budgetTokens: 1050,
		})
		expect(record.cost).toEqual({ listPriceUsd: 0.02265, markup: 1.5, billableUsd: 0.033975 })
		expect(await auditTypes()).toContain('usage_reported')

		// A factory outage keeps the record in the bucket and does not throw
		usageReporter.fail = true
		await expect(resident.flushUsage()).resolves.toBeUndefined()
		expect(store.objects.has(usageKey('2026-09-03'))).toBe(true)
	})

	it('Keeps the audit object per day', async () => {
		const { resident, store, advance } = setup()
		await resident.start()
		advance(24 * 60 * 60_000)
		await resident.addTask({ title: 'Tomorrow', description: 'x' })
		await resident.audit.flush()
		expect([...store.objects.keys()].filter(key => key.startsWith('audit/'))).toEqual([
			auditKey('2026-09-03'),
			auditKey('2026-09-04'),
		])
	})
})

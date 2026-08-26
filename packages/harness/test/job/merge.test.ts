import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { exec, git } from '#job/exec.ts'
import { mergeOrder, mergeTask } from '#job/merge.ts'

import type { Plan, Spec, Task } from '@mf/models'
import type * as worker from '#job/worker.ts'

// The Agent SDK repair session is replaced by a fake that resolves the conflict on disk
const runSession = vi.hoisted(() => vi.fn())
vi.mock('#job/worker.ts', async importOriginal => ({
	...(await importOriginal<typeof worker>()),
	runSession,
}))

const task = (id: string, dependsOn: string[] = []): Task => ({
	id,
	title: id,
	description: id,
	dependsOn,
	areas: [],
	acceptanceCriteriaIds: [],
})

const spec: Spec = { goal: 'x', users: [], features: [], nonGoals: [], stackConstraints: [] }

const gitEnv = {
	GIT_AUTHOR_NAME: 'test',
	GIT_AUTHOR_EMAIL: 'test@example.com',
	GIT_COMMITTER_NAME: 'test',
	GIT_COMMITTER_EMAIL: 'test@example.com',
}

/** Tiny repo with `main` and a branch; `edit` writes + commits a file on the given branch */
const createRepo = async () => {
	const dir = await mkdtemp(join(tmpdir(), 'mf-merge-'))
	const run = (args: string[]) => git(args, { cwd: dir, env: gitEnv })
	await run(['init', '-q', '-b', 'main'])
	await writeFile(join(dir, 'file.txt'), 'base\n')
	await run(['add', '-A'])
	await run(['commit', '-q', '-m', 'init'])

	const edit = async (branch: string, content: string, file = 'file.txt') => {
		const exists =
			(await exec('git', ['rev-parse', '-q', '--verify', branch], { cwd: dir })).code === 0
		await run(exists ? ['checkout', '-q', branch] : ['checkout', '-q', '-b', branch])
		await writeFile(join(dir, file), content)
		await run(['add', '-A'])
		await run(['commit', '-q', '-m', `edit ${branch}`])
		await run(['checkout', '-q', 'main'])
	}
	const read = async (file = 'file.txt') => (await exec('cat', [file], { cwd: dir })).stdout
	return { dir, edit, read, run }
}

describe('merge', () => {
	let repo: Awaited<ReturnType<typeof createRepo>>
	const controller = new AbortController()
	const input = (id: string) => ({
		task: task(id),
		branch: `task/${id}`,
		spec,
		repoDir: repo.dir,
		signal: controller.signal,
		onUsage: vi.fn(),
	})

	beforeEach(async () => {
		repo = await createRepo()
		runSession.mockReset()
	})
	afterEach(() => rm(repo.dir, { recursive: true, force: true }))

	it('mergeOrder follows the DAG, plan order within a wave', () => {
		const plan: Plan = {
			summary: '',
			tasks: [
				task('ui', ['models']),
				task('models'),
				task('api', ['models']),
				task('e2e', ['ui', 'api']),
			],
		}
		expect(mergeOrder(plan)).toEqual(['task/models', 'task/ui', 'task/api', 'task/e2e'])
	})

	it('Merges a clean branch with a merge commit and no model call', async () => {
		await repo.edit('task/a', 'from a\n', 'a.txt')

		const outcome = await mergeTask(input('a'))

		expect(outcome).toEqual({ ok: true, tokens: 0 })
		expect(runSession).not.toHaveBeenCalled()
		expect(await repo.read('a.txt')).toBe('from a\n')
		const log = await repo.run(['log', '--oneline', '-1'])
		expect(log.stdout).toMatch(/merge\(a\): a/)
	})

	it('Runs one repair session on conflict and completes the merge when resolved', async () => {
		await repo.edit('task/b', 'b change\n')
		await repo.edit('main', 'main change\n')
		runSession.mockImplementation(async ({ cwd, onUsage }) => {
			await writeFile(join(cwd, 'file.txt'), 'main change + b change\n')
			await git(['add', '-A'], { cwd, env: gitEnv })
			onUsage({ inputTokens: 300, outputTokens: 30 })
			return { ok: true, tokens: 330, result: 'resolved' }
		})

		const outcome = await mergeTask(input('b'))

		expect(outcome).toEqual({ ok: true, tokens: 330 })
		expect(runSession).toHaveBeenCalledTimes(1)
		expect(runSession.mock.calls[0]![0].systemPrompt).toMatch(/file\.txt/)
		expect(await repo.read()).toBe('main change + b change\n')
		expect(
			(await exec('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: repo.dir })).code
		).not.toBe(0)
	})

	it('Fails closed and aborts the merge when the conflict remains', async () => {
		await repo.edit('task/c', 'c change\n')
		await repo.edit('main', 'main change\n')
		runSession.mockResolvedValue({ ok: true, tokens: 10, result: 'gave up' })

		const outcome = await mergeTask(input('c'))

		expect(outcome.ok).toBe(false)
		expect(outcome.reason).toMatch(/still conflicted.*file\.txt/)
		expect(await repo.read()).toBe('main change\n')
		expect((await repo.run(['status', '--porcelain'])).stdout.trim()).toBe('')
	})

	it('Fails closed when the repair session stages a file that still has conflict markers', async () => {
		await repo.edit('task/d', 'd change\n')
		await repo.edit('main', 'main change\n')
		runSession.mockImplementation(async ({ cwd }) => {
			await writeFile(
				join(cwd, 'file.txt'),
				'<<<<<<< HEAD\nmain change\n=======\nd change\n>>>>>>> task/d\n'
			)
			await git(['add', '-A'], { cwd, env: gitEnv })
			return { ok: true, tokens: 10, result: 'resolved (not really)' }
		})

		const outcome = await mergeTask(input('d'))

		expect(outcome.ok).toBe(false)
		expect(outcome.reason).toMatch(/still conflicted.*file\.txt/)
		expect(await repo.read()).toBe('main change\n')
		expect((await repo.run(['status', '--porcelain'])).stdout.trim()).toBe('')
		expect((await repo.run(['log', '--oneline', '-1'])).stdout).not.toMatch(/merge\(d\)/)
	})
})

import { link, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { exec } from '#job/exec.ts'
import {
	cliJsonSchema,
	createWorkerSpawner,
	createWorktree,
	ensureShared,
	evaluateVitestReport,
	fetchTaskBranch,
	gateCommands,
	gateScopeForAreas,
	gateScopeForChanges,
	hasTestFiles,
	maxTurnsForSpec,
	renderCommand,
	repoConventions,
	protectGitDir,
	removeWorktree,
	resolveEffort,
	sessionEnv,
	shareWithWorker,
	taskConventions,
	verifyRepo,
	workerLimits,
	workerSystemPrompt,
	worktreeDir,
} from '#job/worker.ts'

import type { Plan, Spec, Task } from '@mf/models'

const files = ['apps/app/src/acceptance/f0.c0.test.tsx', 'apps/api/test/acceptance/f1.c0.test.ts']

const passed = (name: string, tests = 1) => ({
	name: `/work/repo/${name}`,
	status: 'passed',
	assertionResults: Array.from({ length: tests }, (_, i) => ({
		fullName: `[${name}] ${i}`,
		status: 'passed',
	})),
})

describe('evaluateVitestReport', () => {
	it('Is green only when every acceptance file ran with passing tests', () => {
		const report = { success: true, testResults: files.map(file => passed(file)) }
		expect(evaluateVitestReport(report, files)).toEqual({
			ok: true,
			output: '2 acceptance test file(s) executed and green',
		})
	})

	it('Is red when a file was not executed (no project picked it up)', () => {
		const report = { success: true, testResults: [passed(files[1]!)] }
		expect(evaluateVitestReport(report, files)).toEqual({
			ok: false,
			output: `acceptance tests not green:\n${files[0]}: not executed`,
		})
	})

	it('Is red on an empty file or a failing/skipped test', () => {
		const empty = { ...passed(files[0]!), assertionResults: [] }
		const failing = {
			...passed(files[1]!),
			status: 'failed',
			assertionResults: [{ fullName: '[f1.c0] cancel', status: 'failed' }],
		}
		const outcome = evaluateVitestReport({ testResults: [empty, failing] }, files)
		expect(outcome.ok).toBe(false)
		expect(outcome.output).toContain(`${files[0]}: no tests`)
		expect(outcome.output).toContain(`${files[1]}: [f1.c0] cancel failed`)

		const skipped = {
			...passed(files[0]!),
			assertionResults: [{ fullName: 'x', status: 'skipped' }],
		}
		expect(evaluateVitestReport({ testResults: [skipped, passed(files[1]!)] }, files).ok).toBe(
			false
		)
	})
})

// MARK: Efficiency (docs/EFFICIENCY.md)

const spec: Spec = { goal: 'x', users: [], features: [], nonGoals: [], stackConstraints: [] }

const task = (areas: string[]): Task => ({
	id: 'app-landing',
	title: 'Landing page',
	description: 'Build it',
	dependsOn: [],
	areas,
	acceptanceCriteriaIds: ['f0.c0'],
})

const plan: Plan = { summary: 'one task', tasks: [task(['apps/app'])] }

describe('gateScopeForAreas', () => {
	it('Scopes apps/* areas (any depth) to their workspaces, deduplicated and sorted', () => {
		expect(gateScopeForAreas(['apps/app/src/pages', 'apps/api', './apps/app'])).toEqual({
			workspaces: ['apps/api', 'apps/app'],
		})
	})

	it('Falls back to the full gate for packages, infra, root files and empty areas', () => {
		expect(gateScopeForAreas([])).toEqual({ full: true })
		expect(gateScopeForAreas(['apps/app', 'packages/models'])).toEqual({ full: true })
		expect(gateScopeForAreas(['infra'])).toEqual({ full: true })
		expect(gateScopeForAreas(['package.json'])).toEqual({ full: true })
	})

	it('Is a full gate when the knob is off', () => {
		const before = workerLimits.scopedTaskGate
		workerLimits.scopedTaskGate = false
		try {
			expect(gateScopeForAreas(['apps/app'])).toEqual({ full: true })
		} finally {
			workerLimits.scopedTaskGate = before
		}
	})
})

describe('gateScopeForChanges', () => {
	it('Keeps the scope when every changed file is inside the task workspaces', () => {
		expect(
			gateScopeForChanges(['apps/app'], ['apps/app/src/x.ts', 'apps/app/vite.config.ts'])
		).toEqual({
			workspaces: ['apps/app'],
		})
	})

	it('Widens to the full gate for a change under packages/*, another app or a root file', () => {
		expect(
			gateScopeForChanges(['apps/app'], ['apps/app/src/x.ts', 'packages/models/schemas/Order.ts'])
		).toEqual({ full: true })
		expect(gateScopeForChanges(['apps/app'], ['apps/api/src/routes/x.ts'])).toEqual({ full: true })
		expect(gateScopeForChanges(['apps/app'], ['vitest.config.ts'])).toEqual({ full: true })
		expect(gateScopeForChanges(['packages/models'], [])).toEqual({ full: true })
	})
})

describe('gateCommands', () => {
	it('Runs the repo-root scripts for the full gate', () => {
		expect(gateCommands({ full: true }).map(renderCommand)).toEqual([
			'npm run lint',
			'npm run test',
		])
	})

	it('Runs lint per workspace and vitest filtered by path for a scoped gate', () => {
		expect(gateCommands({ workspaces: ['apps/api', 'apps/app'] }).map(renderCommand)).toEqual([
			'npm run lint --if-present -w apps/api -w apps/app',
			'npx vitest run --passWithNoTests apps/api apps/app',
		])
	})
})

describe('maxTurnsForSpec', () => {
	it('Caps by the spec size class, S 80 / M 120 / L 160', () => {
		expect(maxTurnsForSpec({ ...spec, sizeClass: 'S' })).toEqual({ size: 'S', maxTurns: 80 })
		expect(maxTurnsForSpec({ ...spec, sizeClass: 'M' })).toEqual({ size: 'M', maxTurns: 120 })
		expect(maxTurnsForSpec({ ...spec, sizeClass: 'L' })).toEqual({ size: 'L', maxTurns: 160 })
	})

	it('Estimates the size when the spec has none (an empty spec is S)', () => {
		expect(maxTurnsForSpec(spec)).toEqual({ size: 'S', maxTurns: 80 })
	})
})

describe('workerSystemPrompt', () => {
	it('Names the scoped gate commands and the at-most-twice rule', () => {
		const prompt = workerSystemPrompt(spec, plan, task(['apps/app']))
		expect(prompt).toContain('`npm run lint --if-present -w apps/app`')
		expect(prompt).toContain('`npx vitest run --passWithNoTests apps/app`')
		expect(prompt).toContain('the full repository is checked again after merge')
		expect(prompt).toContain('at most twice')
		expect(prompt).toContain('tsgo --noemit')
		expect(prompt).toContain('(YOU)')
	})

	it('Falls back to the full-repo commands for shared packages', () => {
		const prompt = workerSystemPrompt(spec, plan, task(['packages/models']))
		expect(prompt).toContain('the whole repository: `npm run lint` and `npm run test`')
	})

	it('Tells the worker that only npm, GitHub and Anthropic are reachable', () => {
		const prompt = workerSystemPrompt(spec, plan, task(['apps/app']))
		expect(prompt).toContain('only the npm registry, GitHub and the Anthropic API are reachable')
		expect(prompt).toContain('every other network call fails')
		expect(repoConventions).toContain('every other network call fails')
		expect(taskConventions).toContain('every other network call fails')
	})

	it('Points at CLAUDE.md instead of telling the worker to read it up front', () => {
		const prompt = workerSystemPrompt(spec, plan, task(['apps/app']))
		expect(prompt).toContain('do not read CLAUDE.md or the rules up front')
		expect(prompt).not.toContain('Run every command from the repository root')
		expect(prompt.length).toBeLessThan(repoConventions.length + 3500)
	})
})

describe('sessionEnv', () => {
	it('Drops every prompt-caching kill switch and the sandbox secrets, keeps the rest', () => {
		const env = sessionEnv({
			PATH: '/usr/bin',
			ANTHROPIC_API_KEY: 'sk-ant',
			DISABLE_PROMPT_CACHING: '1',
			DISABLE_PROMPT_CACHING_HAIKU: '1',
			JOB_TOKEN: 'secret',
		})
		expect(env).toMatchObject({
			PATH: '/usr/bin',
			ANTHROPIC_API_KEY: 'sk-ant',
			CLAUDE_AGENT_SDK_CLIENT_APP: 'mf-harness/0.1',
		})
		expect(Object.keys(env).filter(key => key.startsWith('DISABLE_PROMPT_CACHING'))).toEqual([])
		expect(env.JOB_TOKEN).toBeUndefined()
		expect(env.HOME).toBeUndefined()
	})

	it('Gives the session the worker uid\'s HOME and Claude config dir when one is configured', () => {
		const env = sessionEnv({ PATH: '/usr/bin', HOME: '/home/node', WORKER_UID: '1001' })
		expect(env).toMatchObject({
			PATH: '/usr/bin',
			HOME: '/home/worker',
			CLAUDE_CONFIG_DIR: '/home/worker/.claude',
			WORKER_UID: '1001',
		})
		expect(sessionEnv({ HOME: '/home/node' }).HOME).toBe('/home/node')
	})
})

const mode = async (path: string) => (await stat(path)).mode & 0o7777

/** The sandbox-user tests need util-linux setpriv on PATH (exec wraps every child in it) */
const hasSetpriv = async () =>
	(await exec('setpriv', ['--version'], { cwd: process.cwd() })).code === 0

/** Pretends a sandbox user is configured (a different uid; nothing switches to it here) */
const withSandboxUser = () => {
	const umask = process.umask()
	vi.stubEnv('WORKER_UID', String((process.getuid?.() ?? 0) + 1))
	return () => {
		process.umask(umask)
		vi.unstubAllEnvs()
	}
}

describe('shareWithWorker', () => {
	const fakeTree = async () => {
		const dir = await mkdtemp(join(tmpdir(), 'mf-share-'))
		await mkdir(join(dir, 'src'), { mode: 0o755 })
		await writeFile(join(dir, 'src/a.ts'), 'a', { mode: 0o644 })
		await writeFile(join(dir, 'secret.sh'), 'x', { mode: 0o700 })
		return dir
	}

	/** A `.git` as `git init` leaves it under a setgid work dir: group-writable, setgid dirs */
	const fakeGit = async (dir: string) => {
		await mkdir(join(dir, '.git/refs/heads'), { recursive: true, mode: 0o2775 })
		await writeFile(join(dir, '.git/config'), '[core]\n', { mode: 0o664 })
		await writeFile(join(dir, '.git/refs/heads/main'), 'abc\n', { mode: 0o664 })
	}

	it('Leaves a hard-linked file alone (shared inode) but opens its directory', async () => {
		if (!(await hasSetpriv())) return
		const dir = await fakeTree()
		const restore = withSandboxUser()
		try {
			await mkdir(join(dir, 'template/node_modules/pkg'), { recursive: true, mode: 0o755 })
			await writeFile(join(dir, 'template/node_modules/pkg/index.js'), 'x', { mode: 0o644 })
			await mkdir(join(dir, 'node_modules/pkg'), { recursive: true, mode: 0o755 })
			await link(
				join(dir, 'template/node_modules/pkg/index.js'),
				join(dir, 'node_modules/pkg/index.js')
			)
			await shareWithWorker(dir)
			expect(await mode(join(dir, 'node_modules/pkg/index.js'))).toBe(0o644)
			expect(await mode(join(dir, 'template/node_modules/pkg/index.js'))).toBe(0o644)
			expect(await mode(join(dir, 'node_modules/pkg'))).toBe(0o2775)
			expect(await mode(join(dir, 'src/a.ts'))).toBe(0o664)
		} finally {
			restore()
			await rm(dir, { recursive: true, force: true })
		}
	})

	it('Keeps the main repo\'s .git the job\'s own: readable, never group-writable', async () => {
		if (!(await hasSetpriv())) return
		const dir = await fakeTree()
		await fakeGit(dir)
		const restore = withSandboxUser()
		try {
			await shareWithWorker(dir)
			expect(await mode(join(dir, '.git'))).toBe(0o755)
			expect(await mode(join(dir, '.git/refs/heads'))).toBe(0o755)
			expect(await mode(join(dir, '.git/config'))).toBe(0o644)
			expect(await mode(join(dir, '.git/refs/heads/main'))).toBe(0o644)
			expect((await stat(join(dir, '.git/config'))).gid).toBe(process.getgid?.())
			expect(await mode(join(dir, 'src/a.ts'))).toBe(0o664)

			// A task clone's .git belongs to the worker
			const clone = await fakeTree()
			await fakeGit(clone)
			await shareWithWorker(clone, { gitDir: 'shared' })
			expect(await mode(join(clone, '.git/config'))).toBe(0o664)
			// shared dirs are setgid so worker-created entries stay in the shared group
			expect(await mode(join(clone, '.git'))).toBe(0o2775)
			await rm(clone, { recursive: true, force: true })
		} finally {
			restore()
			await rm(dir, { recursive: true, force: true })
		}
	})

	it('ensureShared shares a tree once but re-protects .git every time', async () => {
		if (!(await hasSetpriv())) return
		const dir = await fakeTree()
		await fakeGit(dir)
		const restore = withSandboxUser()
		try {
			await ensureShared(dir)
			expect(await mode(join(dir, 'src/a.ts'))).toBe(0o664)
			await exec('chmod', ['644', 'src/a.ts'], { cwd: dir })
			await exec('chmod', ['664', '.git/config'], { cwd: dir })
			await ensureShared(dir)
			expect(await mode(join(dir, 'src/a.ts'))).toBe(0o644)
			expect(await mode(join(dir, '.git/config'))).toBe(0o644)
			// No .git, or a gitfile: nothing to protect
			await protectGitDir(join(dir, 'src'))
		} finally {
			restore()
			await rm(dir, { recursive: true, force: true })
		}
	})

	it('Is a no-op without a sandbox user', async () => {
		const dir = await fakeTree()
		try {
			await shareWithWorker(dir)
			expect((await stat(join(dir, 'src/a.ts'))).mode & 0o777).toBe(0o644)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it('Opens the tree to the group: rw on files, rwx on dirs, x kept where it was', async () => {
		const probe = await exec('setpriv', ['--version'], { cwd: process.cwd() })
		if (probe.code !== 0) return
		const dir = await fakeTree()
		const umask = process.umask()
		vi.stubEnv('WORKER_UID', String((process.getuid?.() ?? 0) + 1))
		try {
			await shareWithWorker(dir)
			expect((await stat(join(dir, 'src'))).mode & 0o777).toBe(0o775)
			expect((await stat(join(dir, 'src/a.ts'))).mode & 0o777).toBe(0o664)
			expect((await stat(join(dir, 'secret.sh'))).mode & 0o777).toBe(0o770)
			expect((await stat(join(dir, 'src/a.ts'))).gid).toBe((await stat(dir)).gid)
		} finally {
			process.umask(umask)
			vi.unstubAllEnvs()
			await rm(dir, { recursive: true, force: true })
		}
	})
})

// MARK: Task clones

const gitEnv = {
	GIT_AUTHOR_NAME: 'test',
	GIT_AUTHOR_EMAIL: 'test@example.com',
	GIT_COMMITTER_NAME: 'test',
	GIT_COMMITTER_EMAIL: 'test@example.com',
}

const seedRepo = async () => {
	const root = await mkdtemp(join(tmpdir(), 'mf-clone-'))
	const dir = join(root, 'repo')
	await mkdir(dir)
	const run = (args: string[]) => exec('git', args, { cwd: dir, env: gitEnv })
	await run(['init', '-q', '-b', 'main'])
	await writeFile(join(dir, 'README.md'), 'seed\n')
	await writeFile(join(dir, '.gitignore'), 'node_modules\n')
	await mkdir(join(dir, 'node_modules/pkg'), { recursive: true })
	await writeFile(join(dir, 'node_modules/pkg/index.js'), 'module.exports = 1\n')
	await run(['add', '-A'])
	await run(['commit', '-q', '-m', 'seed'])
	return { root, dir }
}

const taskOf = (id: string): Task => ({ ...task(['apps/app']), id })

describe('createWorktree + fetchTaskBranch', () => {
	it('Clones the main repo per task (own .git, node_modules linked) and fetches the branch back', async () => {
		const { root, dir: repoDir } = await seedRepo()
		try {
			const { dir, branch } = await createWorktree(repoDir, taskOf('t1'))
			expect(dir).toBe(worktreeDir(repoDir, 't1'))
			expect(branch).toBe('task/t1')
			// A full clone, not a linked worktree: .git is a directory with its own refs
			expect((await stat(join(dir, '.git'))).isDirectory()).toBe(true)
			expect((await stat(join(dir, '.git/refs'))).isDirectory()).toBe(true)
			const source = await stat(join(repoDir, 'node_modules/pkg/index.js'))
			expect((await stat(join(dir, 'node_modules/pkg/index.js'))).ino).toBe(source.ino)
			// The branch exists only in the clone until it is fetched
			const before = await exec('git', ['rev-parse', '-q', '--verify', branch], { cwd: repoDir })
			expect(before.code).not.toBe(0)

			await writeFile(join(dir, 'apps.txt'), 'work\n')
			await exec('git', ['add', '-A'], { cwd: dir, env: gitEnv })
			await exec('git', ['commit', '-q', '-m', 'feat: work'], { cwd: dir, env: gitEnv })
			await fetchTaskBranch(repoDir, dir, branch)

			const count = await exec('git', ['rev-list', '--count', `main..${branch}`], { cwd: repoDir })
			expect(count.stdout.trim()).toBe('1')
			const file = await exec('git', ['show', `${branch}:apps.txt`], { cwd: repoDir })
			expect(file.stdout).toBe('work\n')

			// Re-creating the task drops the old branch and clone
			const again = await createWorktree(repoDir, taskOf('t1'))
			expect(again.dir).toBe(dir)
			expect(await readFile(join(dir, 'README.md'), 'utf8')).toBe('seed\n')
			const reset = await exec('git', ['rev-parse', '-q', '--verify', branch], { cwd: repoDir })
			expect(reset.code).not.toBe(0)

			await removeWorktree(repoDir, 't1')
			await expect(stat(dir)).rejects.toThrow()
			await removeWorktree(repoDir, 't1')
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})
})

describe('createWorkerSpawner', () => {
	const stdoutOf = (child: { stdout: NodeJS.ReadableStream }) =>
		new Promise<string>(resolve => {
			let out = ''
			child.stdout.on('data', chunk => (out += String(chunk)))
			child.stdout.on('end', () => resolve(out))
		})
	const exited = (child: { on: (event: 'exit', listener: () => void) => unknown }) =>
		new Promise<void>(resolve => child.on('exit', () => resolve()))

	it('Keeps a stderr tail for the session error and forwards stderr to the log', async () => {
		const forwarded: string[] = []
		const spawner = createWorkerSpawner(chunk => forwarded.push(chunk))
		const child = spawner.spawn({
			command: 'sh',
			args: ['-c', 'echo out; echo "setpriv: reuid failed" >&2; exit 1'],
			cwd: process.cwd(),
			env: process.env,
			signal: new AbortController().signal,
		})
		const [out] = await Promise.all([stdoutOf(child), exited(child)])
		expect(out).toBe('out\n')
		expect(spawner.stderrTail()).toBe('setpriv: reuid failed')
		expect(forwarded.join('')).toContain('setpriv: reuid failed')
	})

	it('Kills what the session backgrounded when the Claude Code process exits', async () => {
		const spawner = createWorkerSpawner(() => {})
		const child = spawner.spawn({
			command: 'sh',
			args: ['-c', 'sleep 30 & echo $!'],
			cwd: process.cwd(),
			env: process.env,
			signal: new AbortController().signal,
		})
		const [out] = await Promise.all([stdoutOf(child), exited(child)])
		const background = Number(out.trim())
		expect(background).toBeGreaterThan(0)
		const deadline = Date.now() + 3000
		const alive = () => {
			try {
				process.kill(background, 0)
				return true
			} catch {
				return false
			}
		}
		while (alive() && Date.now() < deadline) await new Promise(r => setTimeout(r, 25))
		expect(alive()).toBe(false)
	})
})

describe('resolveEffort', () => {
	it('Prefers the explicit level, then a valid WORKER_EFFORT, else the model default', () => {
		expect(resolveEffort('low', { WORKER_EFFORT: 'max' })).toBe('low')
		expect(resolveEffort(undefined, { WORKER_EFFORT: 'medium' })).toBe('medium')
		expect(resolveEffort(undefined, { WORKER_EFFORT: 'turbo' })).toBeUndefined()
		expect(resolveEffort(undefined, {})).toBeUndefined()
	})
})

describe('verifyRepo', () => {
	const fakeRepo = async (lint: Record<string, string>) => {
		const dir = await mkdtemp(join(tmpdir(), 'mf-gate-'))
		await writeFile(
			join(dir, 'package.json'),
			JSON.stringify({ name: 'fake', workspaces: ['apps/*'], scripts: { lint: 'exit 3' } })
		)
		for (const [workspace, script] of Object.entries(lint)) {
			await mkdir(join(dir, workspace), { recursive: true })
			await writeFile(
				join(dir, workspace, 'package.json'),
				JSON.stringify({ name: workspace.replace('/', '-'), scripts: { lint: script } })
			)
		}
		return dir
	}

	it('Runs only the task workspaces and reports the failing scoped command', async () => {
		const dir = await fakeRepo({
			'apps/app': 'echo app-broken; exit 4',
			'apps/api': 'echo api-broken; exit 2',
		})
		const outcome = await verifyRepo(dir, undefined, { areas: ['apps/app/src'] })
		expect(outcome.ok).toBe(false)
		expect(outcome.output).toContain('npm run lint --if-present -w apps/app failed (4)')
		expect(outcome.output).toContain('app-broken')
		expect(outcome.output).not.toContain('api-broken')
		await rm(dir, { recursive: true, force: true })
	})

	it('Widens to the root scripts when the task changed files outside its areas', async () => {
		const dir = await fakeRepo({ 'apps/app': 'echo app-ok' })
		const outcome = await verifyRepo(dir, undefined, {
			areas: ['apps/app'],
			changed: ['apps/app/src/x.ts', 'packages/models/schemas/Order.ts'],
		})
		expect(outcome.ok).toBe(false)
		expect(outcome.output).toContain('npm run lint failed (3)')
		await rm(dir, { recursive: true, force: true })
	})

	it('Is red when the scoped vitest run collected nothing but the workspace has test files', async () => {
		const dir = await fakeRepo({ 'apps/app': 'echo app-ok' })
		// A fake `npx` on PATH that behaves like vitest --passWithNoTests on an unregistered project
		const bin = join(dir, 'bin')
		await mkdir(bin)
		await writeFile(
			join(bin, 'npx'),
			'#!/bin/sh\necho "No test files found, exiting with code 0"\n',
			{
				mode: 0o755,
			}
		)
		const path = process.env.PATH
		process.env.PATH = `${bin}:${path}`
		try {
			await mkdir(join(dir, 'apps/app/src/acceptance'), { recursive: true })
			await writeFile(join(dir, 'apps/app/src/acceptance/f0.c0.test.tsx'), 'test')
			const red = await verifyRepo(dir, undefined, { areas: ['apps/app'] })
			expect(red.ok).toBe(false)
			expect(red.output).toContain('ran no tests, but apps/app contains test files')
			expect(red.output).toContain('root vitest.config.ts')

			await rm(join(dir, 'apps/app/src'), { recursive: true })
			const green = await verifyRepo(dir, undefined, { areas: ['apps/app'] })
			expect(green).toEqual({
				ok: true,
				output:
					'npm run lint --if-present -w apps/app: ok\nnpx vitest run --passWithNoTests apps/app: ok (no test files in apps/app)',
			})
		} finally {
			process.env.PATH = path
			await rm(dir, { recursive: true, force: true })
		}
	})

	it('Runs the root scripts without areas (merge/verify gate)', async () => {
		const dir = await fakeRepo({ 'apps/app': 'echo app-ok' })
		const outcome = await verifyRepo(dir)
		expect(outcome.ok).toBe(false)
		expect(outcome.output).toContain('npm run lint failed (3)')
		await rm(dir, { recursive: true, force: true })
	})
})

describe('hasTestFiles', () => {
	it('Finds *.test.* / *.spec.* files and skips node_modules and dist', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'mf-tests-'))
		await mkdir(join(dir, 'node_modules/x'), { recursive: true })
		await writeFile(join(dir, 'node_modules/x/a.test.js'), '')
		expect(await hasTestFiles(dir)).toBe(false)
		await mkdir(join(dir, 'src/deep'), { recursive: true })
		await writeFile(join(dir, 'src/deep/a.spec.tsx'), '')
		expect(await hasTestFiles(dir)).toBe(true)
		expect(await hasTestFiles(join(dir, 'missing'))).toBe(false)
		await rm(dir, { recursive: true, force: true })
	})
})

describe('cliJsonSchema', () => {
	it('Drops the $schema/$id keywords Zod adds, keeps everything else', () => {
		expect(
			cliJsonSchema({ $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'x', type: 'object', properties: { a: { type: 'string' } } })
		).toEqual({ type: 'object', properties: { a: { type: 'string' } } })
	})
})

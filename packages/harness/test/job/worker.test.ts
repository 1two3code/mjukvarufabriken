import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
	evaluateVitestReport,
	gateCommands,
	gateScopeForAreas,
	gateScopeForChanges,
	hasTestFiles,
	maxTurnsForSpec,
	renderCommand,
	repoConventions,
	resolveEffort,
	sessionEnv,
	verifyRepo,
	workerLimits,
	workerSystemPrompt,
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
	it('Caps by the spec size class, S 60 / M 100 / L 150', () => {
		expect(maxTurnsForSpec({ ...spec, sizeClass: 'S' })).toEqual({ size: 'S', maxTurns: 60 })
		expect(maxTurnsForSpec({ ...spec, sizeClass: 'M' })).toEqual({ size: 'M', maxTurns: 100 })
		expect(maxTurnsForSpec({ ...spec, sizeClass: 'L' })).toEqual({ size: 'L', maxTurns: 150 })
	})

	it('Estimates the size when the spec has none (an empty spec is S)', () => {
		expect(maxTurnsForSpec(spec)).toEqual({ size: 'S', maxTurns: 60 })
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

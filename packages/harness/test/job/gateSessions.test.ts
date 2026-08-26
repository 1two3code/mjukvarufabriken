import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { exec } from '#job/exec.ts'
import {
	acceptanceCheckGate,
	acceptanceTestsGate,
	criteriaOf,
	discardChanges,
	evaluateAcceptanceReport,
	findAcceptanceTests,
	findingId,
	isProtectedTestPath,
	parseHunks,
	remapLine,
	remapWaivers,
	reviewGate,
	snapshotRepo,
} from '#job/gateSessions.ts'
import {
	readOnlyTools,
	runAcceptanceTests,
	runSession,
	verifyRepo,
	workerTools,
} from '#job/worker.ts'

import type { Spec } from '@mf/models'
import type { GateInput } from '#job/types.ts'
import type * as WorkerModule from '#job/worker.ts'
import type { SessionInput, SessionOutcome } from '#job/worker.ts'

vi.mock('#job/worker.ts', async importOriginal => ({
	...(await importOriginal<typeof WorkerModule>()),
	runSession: vi.fn(),
	verifyRepo: vi.fn(),
	runAcceptanceTests: vi.fn(),
}))

// MARK: Fixtures

const spec: Spec = {
	goal: 'book classes',
	users: ['member'],
	features: [
		{ title: 'Schedule', description: '', acceptanceCriteria: ['see the week', 'book a class'] },
		{ title: 'Staff', description: '', acceptanceCriteria: ['cancel a class'] },
	],
	nonGoals: [],
	stackConstraints: [],
}

const gitEnv = {
	GIT_AUTHOR_NAME: 't',
	GIT_AUTHOR_EMAIL: 't@t',
	GIT_COMMITTER_NAME: 't',
	GIT_COMMITTER_EMAIL: 't@t',
}

const gitRun = (repoDir: string, args: string[]) => exec('git', args, { cwd: repoDir, env: gitEnv })

const initRepo = async () => {
	const repoDir = await mkdtemp(join(tmpdir(), 'mf-gates-'))
	await gitRun(repoDir, ['init', '-q', '-b', 'main'])
	await writeFile(join(repoDir, 'package.json'), '{"name":"t"}\n')
	await writeFile(join(repoDir, 'app.ts'), 'export const a = 1\n')
	await gitRun(repoDir, ['add', '-A'])
	await gitRun(repoDir, ['commit', '-q', '-m', 'chore: seed'])
	return repoDir
}

const writeTest = async (repoDir: string, dir: string, id: string, ext = 'tsx') => {
	await mkdir(join(repoDir, dir), { recursive: true })
	await writeFile(join(repoDir, dir, `${id}.test.${ext}`), `it('[${id}]', () => {})\n`)
}

const writeAllTests = (repoDir: string) =>
	Promise.all([
		writeTest(repoDir, 'apps/app/src/acceptance', 'f0.c0'),
		writeTest(repoDir, 'apps/app/src/acceptance', 'f0.c1'),
		writeTest(repoDir, 'apps/api/test/acceptance', 'f1.c0', 'ts'),
	])

const session = (overrides: Partial<SessionOutcome> = {}): SessionOutcome => ({
	ok: true,
	tokens: 10,
	result: 'done',
	...overrides,
})

/** Queue session outcomes; each can also act on the repo (write files, ...) */
const queueSessions = (steps: ((input: SessionInput) => Promise<SessionOutcome>)[]) => {
	const prompts: SessionInput[] = []
	vi.mocked(runSession).mockImplementation(async input => {
		prompts.push(input)
		input.onUsage({ inputTokens: 10, outputTokens: 0 })
		const step = steps[prompts.length - 1]
		if (!step) throw new Error(`unexpected session #${prompts.length}`)
		return step(input)
	})
	return prompts
}

const queueVerify = (...results: boolean[]) => {
	const mock = vi.mocked(verifyRepo)
	for (const ok of results) {
		mock.mockResolvedValueOnce({ ok, output: ok ? 'green' : 'npm test failed: f0.c1' })
	}
}

const queueAcceptanceRun = (...results: boolean[]) => {
	const mock = vi.mocked(runAcceptanceTests)
	for (const ok of results) {
		mock.mockResolvedValueOnce({
			ok,
			output: ok ? '3 acceptance test file(s) executed and green' : 'f0.c0: not executed',
		})
	}
}

let repoDir: string
let input: GateInput
let usage: number

beforeEach(async () => {
	Object.assign(process.env, gitEnv)
	repoDir = await initRepo()
	usage = 0
	input = {
		spec,
		repoDir,
		waivers: [],
		signal: new AbortController().signal,
		onUsage: u => (usage += u.inputTokens + u.outputTokens),
	}
	vi.mocked(runSession).mockReset()
	vi.mocked(verifyRepo).mockReset()
	vi.mocked(runAcceptanceTests).mockReset()
	vi.mocked(runAcceptanceTests).mockResolvedValue({ ok: true, output: 'green' })
})
afterEach(() => rm(repoDir, { recursive: true, force: true }))

// MARK: Pure helpers

describe('criteriaOf', () => {
	it('Numbers criteria f<feature>.c<criterion>, zero-based', () => {
		expect(criteriaOf(spec).map(c => c.id)).toEqual(['f0.c0', 'f0.c1', 'f1.c0'])
		expect(criteriaOf(spec)[2]).toEqual({ id: 'f1.c0', feature: 'Staff', text: 'cancel a class' })
	})
})

describe('findAcceptanceTests', () => {
	it('Finds <id>.test.ts[x] in every acceptance directory under apps/', async () => {
		await writeAllTests(repoDir)
		await writeTest(repoDir, 'apps/app/src/acceptance', 'unrelated')

		const files = await findAcceptanceTests(repoDir, criteriaOf(spec))

		expect(files.get('f0.c0')).toEqual(['apps/app/src/acceptance/f0.c0.test.tsx'])
		expect(files.get('f1.c0')).toEqual(['apps/api/test/acceptance/f1.c0.test.ts'])
		expect(files.has('unrelated')).toBe(false)
	})
})

describe('isProtectedTestPath', () => {
	it('Protects acceptance dirs, vitest/vite configs, package.json and setup files', () => {
		for (const path of [
			'apps/app/src/acceptance/f0.c0.test.tsx',
			'apps/app/vitest.config.ts',
			'vitest.workspace.mts',
			'apps/app/vite.config.ts',
			'apps/app/package.json',
			'package.json',
			'apps/app/src/setupTests.ts',
			'apps/api/test/setup.ts',
		]) {
			expect(isProtectedTestPath(path), path).toBe(true)
		}
		for (const path of ['apps/app/src/App.tsx', 'apps/api/src/routes/x.ts', 'package-lock.json']) {
			expect(isProtectedTestPath(path), path).toBe(false)
		}
	})
})

describe('remapLine', () => {
	it('Parses -U0 hunks and shifts, moves or drops lines', () => {
		const hunks = parseHunks(
			'diff --git a/x b/x\n@@ -2,0 +3,2 @@ ctx\n+a\n+b\n@@ -10,2 +13,3 @@\n-c\n-d\n+e\n+f\n+g\n@@ -20 +24,0 @@\n-h\n'
		)
		expect(hunks).toEqual([
			{ oldStart: 2, oldCount: 0, newStart: 3, newCount: 2 },
			{ oldStart: 10, oldCount: 2, newStart: 13, newCount: 3 },
			{ oldStart: 20, oldCount: 1, newStart: 24, newCount: 0 },
		])
		expect(remapLine(hunks, 1)).toBe(1)
		expect(remapLine(hunks, 2)).toBe(2)
		expect(remapLine(hunks, 3)).toBe(5)
		expect(remapLine(hunks, 11)).toBe(14)
		expect(remapLine(hunks, 12)).toBe(15)
		expect(remapLine(hunks, 20)).toBeUndefined()
		expect(remapLine(hunks, 21)).toBe(23)
		expect(remapLine([], 7)).toBe(7)
	})

	it('remapWaivers translates through the real git diff and keeps non-line waivers', async () => {
		const before = (await gitRun(repoDir, ['rev-parse', 'HEAD'])).stdout.trim()
		await writeFile(join(repoDir, 'app.ts'), 'const x = 1\nexport const a = 1\n')
		await gitRun(repoDir, ['commit', '-qam', 'shift'])

		const mapped = await remapWaivers(
			repoDir,
			['app.ts:1', 'other.ts:5', 'not-a-line-waiver'],
			before,
			input.signal
		)

		expect(mapped).toEqual(['app.ts:2', 'other.ts:5', 'not-a-line-waiver'])
	})
})

describe('discardChanges', () => {
	it('Resets to the snapshot and reports whether git state had moved', async () => {
		const snapshot = await snapshotRepo(repoDir)
		expect(snapshot.branch).toBe('main')
		await writeFile(join(repoDir, 'app.ts'), 'x\n')
		expect(await discardChanges(repoDir, snapshot)).toBe(false)

		await gitRun(repoDir, ['commit', '-q', '--allow-empty', '-m', 'sneaky'])
		expect(await discardChanges(repoDir, snapshot)).toBe(true)
		expect((await gitRun(repoDir, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(snapshot.head)
	})
})

describe('evaluateAcceptanceReport', () => {
	const criteria = criteriaOf(spec)
	const met = { evidence: ['apps/app/src/acceptance/x.test.tsx'], status: 'met' as const }

	it('Passes when every criterion is met', () => {
		const outcome = evaluateAcceptanceReport(criteria, { 'f0.c0': met, 'f0.c1': met, 'f1.c0': met })
		expect(outcome.ok).toBe(true)
		expect(outcome.summary).toBe('3 criterion(s) met with evidence')
	})

	it('Fails on unmet, and treats a missing criterion as unknown', () => {
		const outcome = evaluateAcceptanceReport(criteria, {
			'f0.c0': met,
			'f0.c1': { evidence: [], status: 'unmet' },
		})
		expect(outcome.ok).toBe(false)
		expect(outcome.summary).toBe('2 criterion(s) not met: f0.c1 (unmet), f1.c0 (unknown)')
		expect((outcome.details as { report: Record<string, unknown> }).report['f1.c0']).toEqual({
			evidence: [],
			status: 'unknown',
		})
	})
})

// MARK: Gate 1

describe('acceptanceTestsGate', () => {
	it('Passes when the session writes a test per criterion and they are green', async () => {
		const prompts = queueSessions([
			async () => {
				await writeAllTests(repoDir)
				return session()
			},
		])
		queueVerify(true)

		const outcome = await acceptanceTestsGate(input)

		expect(outcome.ok).toBe(true)
		expect(outcome.summary).toBe('3 acceptance test(s) green')
		expect(outcome.tokens).toBe(10)
		expect(usage).toBe(10)
		// The acceptance files are run explicitly, not only via the root `npm test`
		expect(runAcceptanceTests).toHaveBeenCalledWith(
			repoDir,
			[
				'apps/app/src/acceptance/f0.c0.test.tsx',
				'apps/app/src/acceptance/f0.c1.test.tsx',
				'apps/api/test/acceptance/f1.c0.test.ts',
			],
			input.signal
		)
		expect(prompts[0]!.systemPrompt).toContain('- [f0.c1] (Schedule) book a class')
		expect(prompts[0]!.tools).toBeUndefined()
		// The tests were committed by the gate
		const status = await gitRun(repoDir, ['status', '--porcelain'])
		expect(status.stdout.trim()).toBe('')
		expect((await gitRun(repoDir, ['log', '--oneline'])).stdout).toMatch(/test\(acceptance\)/)
	})

	it('Fails when a criterion has no test file', async () => {
		queueSessions([
			async () => {
				await writeTest(repoDir, 'apps/app/src/acceptance', 'f0.c0')
				return session()
			},
		])

		const outcome = await acceptanceTestsGate(input)

		expect(outcome.ok).toBe(false)
		expect(outcome.summary).toBe('no acceptance test written for: f0.c1, f1.c0')
		expect(verifyRepo).not.toHaveBeenCalled()
	})

	it('Runs one fix session on red, restores the tests it touched, then passes', async () => {
		const testFile = join(repoDir, 'apps/app/src/acceptance/f0.c1.test.tsx')
		const prompts = queueSessions([
			async () => {
				await writeAllTests(repoDir)
				return session()
			},
			async () => {
				// The fix session cheats: it edits the app AND weakens a test
				await writeFile(join(repoDir, 'app.ts'), 'export const a = 2\n')
				await writeFile(testFile, 'it.skip()\n')
				return session()
			},
		])
		queueVerify(false, true)

		const outcome = await acceptanceTestsGate(input)

		expect(outcome.ok).toBe(true)
		expect(outcome.summary).toBe('3 acceptance test(s) green after one fix')
		expect(outcome.details).toMatchObject({ fixed: true })
		expect(prompts).toHaveLength(2)
		expect(prompts[1]!.prompt).toContain('npm test failed: f0.c1')
		expect(prompts[1]!.systemPrompt).toContain('Never edit, delete, skip or weaken')
		expect(await readFile(testFile, 'utf8')).toBe("it('[f0.c1]', () => {})\n")
		expect(await readFile(join(repoDir, 'app.ts'), 'utf8')).toBe('export const a = 2\n')
	})

	it('Is red when the acceptance files were not executed, even though npm test is green', async () => {
		queueSessions([
			async () => {
				await writeAllTests(repoDir)
				return session()
			},
			async () => session(),
		])
		queueVerify(true, true)
		queueAcceptanceRun(false, false)

		const outcome = await acceptanceTestsGate(input)

		expect(outcome.ok).toBe(false)
		expect(outcome.summary).toMatch(/still red after one fix:\nf0.c0: not executed/)
		expect(runSession).toHaveBeenCalledTimes(2)
	})

	it('Restores the vitest config, package.json scripts and setup files the fix touched', async () => {
		const config = join(repoDir, 'apps/app/vitest.config.ts')
		const setup = join(repoDir, 'apps/app/src/setupTests.ts')
		const prompts = queueSessions([
			async () => {
				await writeAllTests(repoDir)
				await writeFile(config, 'export default {}\n')
				await writeFile(setup, 'import "@testing-library/jest-dom"\n')
				return session()
			},
			async () => {
				// The fix session neutralises the tests without touching the test files
				await writeFile(config, "export default { test: { exclude: ['**/acceptance/**'] } }\n")
				await writeFile(join(repoDir, 'package.json'), '{"name":"t","scripts":{"test":"true"}}\n')
				await writeFile(join(repoDir, 'vitest.workspace.ts'), 'export default []\n')
				await rm(setup)
				await writeFile(join(repoDir, 'app.ts'), 'export const a = 2\n')
				return session()
			},
		])
		queueVerify(false, true)

		const outcome = await acceptanceTestsGate(input)

		expect(outcome.ok).toBe(true)
		expect(prompts).toHaveLength(2)
		expect(outcome.details).toMatchObject({
			restored: expect.arrayContaining([
				'apps/app/vitest.config.ts',
				'package.json',
				'vitest.workspace.ts',
				'apps/app/src/setupTests.ts',
			]),
		})
		expect(await readFile(config, 'utf8')).toBe('export default {}\n')
		expect(await readFile(join(repoDir, 'package.json'), 'utf8')).toBe('{"name":"t"}\n')
		expect(await readFile(setup, 'utf8')).toBe('import "@testing-library/jest-dom"\n')
		await expect(readFile(join(repoDir, 'vitest.workspace.ts'))).rejects.toThrow()
		expect(await readFile(join(repoDir, 'app.ts'), 'utf8')).toBe('export const a = 2\n')
		expect((await gitRun(repoDir, ['status', '--porcelain'])).stdout.trim()).toBe('')
	})

	it('Fails when still red after the one fix', async () => {
		queueSessions([
			async () => {
				await writeAllTests(repoDir)
				return session()
			},
			async () => session(),
		])
		queueVerify(false, false)

		const outcome = await acceptanceTestsGate(input)

		expect(outcome.ok).toBe(false)
		expect(outcome.summary).toMatch(/still red after one fix/)
		expect(runSession).toHaveBeenCalledTimes(2)
	})

	it('Fails when the test-writing session fails, and reports an abort as such', async () => {
		queueSessions([async () => session({ ok: false, result: 'error_max_turns' })])
		expect((await acceptanceTestsGate(input)).summary).toBe(
			'test-writing session failed: error_max_turns'
		)

		const controller = new AbortController()
		queueSessions([
			async () => {
				controller.abort()
				return session()
			},
		])
		const outcome = await acceptanceTestsGate({ ...input, signal: controller.signal })
		expect(outcome).toEqual({ ok: false, tokens: 10, summary: 'aborted' })
	})
})

// MARK: Gate 2

const high = {
	severity: 'high' as const,
	file: 'app.ts',
	line: 1,
	claim: 'wrong',
	failureScenario: 'x → y',
}
const low = { ...high, severity: 'low' as const, line: 2 }

describe('reviewGate', () => {
	it('Runs read-only with the structured output schema and passes on no findings', async () => {
		const prompts = queueSessions([async () => session({ structuredOutput: { findings: [] } })])

		const outcome = await reviewGate({ ...input, seedCommit: 'abc123' })

		expect(outcome.ok).toBe(true)
		expect(outcome.summary).toBe('0 finding(s), none high/medium open')
		expect(outcome.details).toMatchObject({ range: 'abc123..HEAD', fixed: false })
		expect(prompts[0]!.tools).toEqual(readOnlyTools)
		expect(prompts[0]!.outputSchema).toBeDefined()
		expect(prompts[0]!.systemPrompt).toContain('READ-ONLY')
		expect(prompts[0]!.systemPrompt).toContain('git diff abc123..HEAD')
	})

	it('Defaults the diff base to the root commit', async () => {
		const prompts = queueSessions([async () => session({ structuredOutput: { findings: [] } })])
		const root = (await gitRun(repoDir, ['rev-list', '--max-parents=0', 'HEAD'])).stdout.trim()

		await reviewGate(input)

		expect(prompts[0]!.systemPrompt).toContain(`git diff ${root}..HEAD`)
	})

	it('Records low findings without a fix session', async () => {
		queueSessions([async () => session({ structuredOutput: { findings: [low] } })])

		const outcome = await reviewGate(input)

		expect(outcome.ok).toBe(true)
		expect(outcome.details).toMatchObject({ findings: [{ ...low, id: 'app.ts:2' }] })
		expect(runSession).toHaveBeenCalledTimes(1)
	})

	it('Fixes high/medium findings once, re-verifies and re-reviews, then passes', async () => {
		const prompts = queueSessions([
			async () => session({ structuredOutput: { findings: [high, low] } }),
			async () => {
				await writeFile(join(repoDir, 'app.ts'), 'export const a = 2\n')
				return session()
			},
			async () => session({ structuredOutput: { findings: [low] } }),
		])
		queueVerify(true)

		const outcome = await reviewGate(input)

		expect(outcome.ok).toBe(true)
		expect(outcome.summary).toBe('1 finding(s) fixed, 1 remaining (no open high)')
		expect(outcome.details).toMatchObject({ fixed: true, findingsAfterFix: [{ id: 'app.ts:2' }] })
		expect(prompts[1]!.tools).toBeUndefined()
		expect(prompts[1]!.systemPrompt).toContain('[app.ts:1] HIGH app.ts:1 — wrong')
		expect(prompts[1]!.systemPrompt).not.toContain('app.ts:2')
		expect(prompts[2]!.tools).toEqual(readOnlyTools)
		expect((await gitRun(repoDir, ['log', '--oneline'])).stdout).toMatch(/fix\(review\)/)
	})

	it('Fails when a high finding is still open after the fix', async () => {
		queueSessions([
			async () => session({ structuredOutput: { findings: [high] } }),
			async () => session(),
			async () => session({ structuredOutput: { findings: [high] } }),
		])
		queueVerify(true)

		const outcome = await reviewGate(input)

		expect(outcome.ok).toBe(false)
		expect(outcome.summary).toBe('1 high finding(s) still open after one fix: app.ts:1 wrong')
		expect(outcome.tokens).toBe(30)
	})

	it('Fails when the fix breaks lint/test', async () => {
		queueSessions([
			async () => session({ structuredOutput: { findings: [high] } }),
			async () => session(),
		])
		queueVerify(false)

		const outcome = await reviewGate(input)

		expect(outcome.ok).toBe(false)
		expect(outcome.summary).toMatch(/lint\/test red after the review fix/)
		expect(runSession).toHaveBeenCalledTimes(2)
	})

	it('Honours waivers: a waived high finding needs no fix', async () => {
		queueSessions([async () => session({ structuredOutput: { findings: [high] } })])

		const outcome = await reviewGate({ ...input, waivers: [findingId(high)] })

		expect(outcome.ok).toBe(true)
		expect(outcome.details).toMatchObject({ waived: ['app.ts:1'] })
		expect(runSession).toHaveBeenCalledTimes(1)
	})

	it('Undoes commits, resets and branch switches a read-only session made', async () => {
		const head = (await gitRun(repoDir, ['rev-parse', 'HEAD'])).stdout.trim()
		queueSessions([
			async () => {
				// The "read-only" reviewer rewrites history: a commit, then a detached checkout
				await writeFile(join(repoDir, 'app.ts'), 'export const a = 3\n')
				await gitRun(repoDir, ['add', '-A'])
				await gitRun(repoDir, ['commit', '-q', '-m', 'sneaky'])
				await gitRun(repoDir, ['checkout', '-q', '--detach', 'HEAD~1'])
				await gitRun(repoDir, ['reset', '-q', '--hard', 'HEAD'])
				return session({ structuredOutput: { findings: [] } })
			},
		])

		const outcome = await reviewGate(input)

		expect(outcome.ok).toBe(true)
		expect((await gitRun(repoDir, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(head)
		expect((await gitRun(repoDir, ['symbolic-ref', '--short', 'HEAD'])).stdout.trim()).toBe('main')
		expect(await readFile(join(repoDir, 'app.ts'), 'utf8')).toBe('export const a = 1\n')
	})

	it('Moves waivers along with the lines the fix session shifted', async () => {
		// Waived high at app.ts:1; the fix inserts 3 lines above it and a new high lands on line 1
		const waivedHigh = { ...high, line: 1, claim: 'waived defect' }
		const newHighAtOldLine = { ...high, line: 1, claim: 'brand new defect' }
		const movedWaived = { ...waivedHigh, line: 4 }
		const medium = { ...high, severity: 'medium' as const, line: 2, claim: 'to fix' }
		queueSessions([
			async () => session({ structuredOutput: { findings: [waivedHigh, medium] } }),
			async () => {
				await writeFile(
					join(repoDir, 'app.ts'),
					'const x = 1\nconst y = 2\nconst z = 3\nexport const a = 1\n'
				)
				return session()
			},
			async () => session({ structuredOutput: { findings: [movedWaived] } }),
		])
		queueVerify(true)

		const outcome = await reviewGate({ ...input, waivers: ['app.ts:1'] })

		expect(outcome.ok).toBe(true)
		expect(outcome.details).toMatchObject({ waived: ['app.ts:1'], waiversAfterFix: ['app.ts:4'] })

		// The stale line must not waive a different finding that now sits at app.ts:1
		queueSessions([
			async () => session({ structuredOutput: { findings: [waivedHigh, medium] } }),
			async () => {
				await writeFile(
					join(repoDir, 'app.ts'),
					'const q = 1\nconst x = 1\nconst y = 2\nconst z = 3\nexport const a = 1\n'
				)
				return session()
			},
			async () => session({ structuredOutput: { findings: [newHighAtOldLine] } }),
		])
		queueVerify(true)
		const second = await reviewGate({ ...input, waivers: ['app.ts:1'] })
		expect(second.ok).toBe(false)
		expect(second.summary).toMatch(/1 high finding\(s\) still open/)
	})

	it('Fails on invalid structured output and discards anything the session wrote', async () => {
		queueSessions([
			async () => {
				await writeFile(join(repoDir, 'app.ts'), 'tampered\n')
				await writeFile(join(repoDir, 'new.ts'), 'x\n')
				return session({ structuredOutput: { findings: [{ severity: 'urgent' }] } })
			},
		])

		const outcome = await reviewGate(input)

		expect(outcome.ok).toBe(false)
		expect(outcome.summary).toMatch(/^review output invalid/)
		expect((await gitRun(repoDir, ['status', '--porcelain'])).stdout.trim()).toBe('')
	})

	it('Reports an abort during the review as aborted', async () => {
		const controller = new AbortController()
		queueSessions([
			async () => {
				controller.abort()
				return session({ ok: false, result: 'aborted' })
			},
		])

		const outcome = await reviewGate({ ...input, signal: controller.signal })
		expect(outcome).toEqual({ ok: false, tokens: 10, summary: 'aborted' })
	})
})

// MARK: Gate 3

describe('acceptanceCheckGate', () => {
	const met = {
		evidence: ['apps/app/src/acceptance/f0.c0.test.tsx: renders the week'],
		status: 'met',
	}

	it('Passes a complete, all-met report from a read-only session', async () => {
		const prompts = queueSessions([
			async () =>
				session({ structuredOutput: { report: { 'f0.c0': met, 'f0.c1': met, 'f1.c0': met } } }),
		])

		const outcome = await acceptanceCheckGate(input)

		expect(outcome.ok).toBe(true)
		expect(outcome.summary).toBe('3 criterion(s) met with evidence')
		expect(prompts[0]!.tools).toEqual(readOnlyTools)
		expect(prompts[0]!.tools).not.toEqual(workerTools)
		expect(prompts[0]!.outputSchema).toBeDefined()
	})

	it('Fails on unmet or missing criteria', async () => {
		queueSessions([
			async () =>
				session({
					structuredOutput: {
						report: { 'f0.c0': met, 'f0.c1': { evidence: [], status: 'unmet' } },
					},
				}),
		])

		const outcome = await acceptanceCheckGate(input)

		expect(outcome.ok).toBe(false)
		expect(outcome.summary).toBe('2 criterion(s) not met: f0.c1 (unmet), f1.c0 (unknown)')
	})

	it('Fails on an invalid report or a failed session', async () => {
		queueSessions([
			async () => session({ structuredOutput: { report: { 'f0.c0': { status: 'yes' } } } }),
		])
		expect((await acceptanceCheckGate(input)).summary).toMatch(/^acceptance report invalid/)

		queueSessions([async () => session({ ok: false, result: 'error_max_turns: x' })])
		expect((await acceptanceCheckGate(input)).summary).toBe(
			'acceptance-check session failed: error_max_turns: x'
		)
	})
})

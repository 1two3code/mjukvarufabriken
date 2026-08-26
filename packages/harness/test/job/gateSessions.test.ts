import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { exec } from '#job/exec.ts'
import {
	acceptanceCheckGate,
	acceptanceTestsGate,
	criteriaOf,
	evaluateAcceptanceReport,
	findAcceptanceTests,
	findingId,
	reviewGate,
} from '#job/gateSessions.ts'
import { readOnlyTools, runSession, verifyRepo, workerTools } from '#job/worker.ts'

import type { Spec } from '@mf/models'
import type { GateInput } from '#job/types.ts'
import type * as WorkerModule from '#job/worker.ts'
import type { SessionInput, SessionOutcome } from '#job/worker.ts'

vi.mock('#job/worker.ts', async importOriginal => ({
	...(await importOriginal<typeof WorkerModule>()),
	runSession: vi.fn(),
	verifyRepo: vi.fn(),
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

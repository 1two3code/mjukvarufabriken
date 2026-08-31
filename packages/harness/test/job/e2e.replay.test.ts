import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createFakeDeliveryClients } from '#job/delivery/index.ts'
import { exec } from '#job/exec.ts'
import { runJob } from '#job/orchestrator.ts'
import { createLivePorts } from '#job/ports.ts'
import { planToolName } from '#job/planner.ts'
import { setSessionQuery } from '#job/worker.ts'
import {
	Cassette,
	recordQuery,
	recordSpecEngineClient,
	replayQuery,
	replaySpecEngineClient,
} from '#testing/cassette.ts'

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type Anthropic from '@anthropic-ai/sdk'
import type { DeliveryClients } from '#job/delivery/types.ts'
import type { NewJobEvent, Plan, Spec } from '@mf/models'
import type { FakeArtifactStore } from '#job/delivery/artifacts.ts'
import type { JobInput, RunJobOptions } from '#job/types.ts'
import type { SessionQuery } from '#job/worker.ts'

// MARK: A minimal scenario — one task, one criterion, so the committed cassette stays small

const spec: Spec = {
	goal: 'A tiny landing page',
	users: ['visitors'],
	features: [
		{ title: 'Landing page', description: 'A hero section', acceptanceCriteria: ['The landing page renders a hero'] },
	],
	nonGoals: [],
	stackConstraints: [],
	sizeClass: 'S',
}

const plan: Plan = {
	summary: 'Build the whole landing page in one task.',
	tasks: [
		{ id: 'landing', title: 'Landing page', description: 'Build the landing page hero.', dependsOn: [], areas: ['apps/api'], acceptanceCriteriaIds: ['f0.c0'] },
	],
}

// MARK: The two model seams as deterministic fakes (the "real" side of a record run)

const planMessage: Anthropic.Message = {
	id: 'msg_plan',
	type: 'message',
	role: 'assistant',
	model: 'fake',
	content: [{ type: 'tool_use', id: 'toolu_plan', name: planToolName, input: plan }],
	stop_reason: 'tool_use',
	stop_sequence: null,
	usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 0 },
} as unknown as Anthropic.Message

let messageSeq = 0
const assistantMessage = (): SDKMessage =>
	({
		type: 'assistant',
		message: {
			id: `msg_${(messageSeq += 1)}`,
			usage: { input_tokens: 20, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
		},
	}) as unknown as SDKMessage

const successResult = (extra: Record<string, unknown> = {}): SDKMessage =>
	({ type: 'result', subtype: 'success', is_error: false, result: 'done', errors: [], num_turns: 1, total_cost_usd: 0, modelUsage: {}, ...extra }) as unknown as SDKMessage

const criterionIdsOf = (systemPrompt: string) => [
	...new Set([...systemPrompt.matchAll(/\[(f\d+\.c\d+)\]/g)].map(match => match[1]!)),
]

const write = async (dir: string, relativePath: string, content: string) => {
	const full = join(dir, relativePath)
	await mkdir(dirname(full), { recursive: true })
	await writeFile(full, content)
}

/** A stand-in Agent SDK session that makes small REAL edits (kept green) per role */
const fakeQuery: SessionQuery = async function* (input) {
	const systemPrompt = typeof input.options.systemPrompt === 'string' ? input.options.systemPrompt : ''
	const cwd = input.options.cwd!
	if (systemPrompt.includes('You are the QA engineer at Mjukvaruhuset')) {
		for (const id of criterionIdsOf(systemPrompt)) {
			await write(cwd, `apps/api/test/acceptance/${id}.test.ts`, `it('[${id}] replay acceptance', () => {\n\texpect(true).toBe(true)\n})\n`)
		}
		yield assistantMessage()
		yield successResult()
		return
	}
	if (systemPrompt.includes('You are the independent reviewer at Mjukvaruhuset')) {
		yield assistantMessage()
		yield successResult({ structured_output: { findings: [] } })
		return
	}
	if (systemPrompt.includes('You are the acceptance checker at Mjukvaruhuset')) {
		const report = Object.fromEntries(
			criterionIdsOf(systemPrompt).map(id => [id, { evidence: [`apps/api/test/acceptance/${id}.test.ts`], status: 'met' }])
		)
		yield assistantMessage()
		yield successResult({ structured_output: { report } })
		return
	}
	// Worker (or any fix session): one trivial, green addition
	const taskId = basename(cwd)
	const name = `mfReplay${taskId[0]!.toUpperCase()}${taskId.slice(1)}`
	await write(cwd, `apps/api/src/${name}.ts`, `export const ${name} = true\n`)
	yield assistantMessage()
	yield successResult()
}

// MARK: Repo seeding (same shape as the offline e2e; node_modules hard-linked for speed)

const templateDir = fileURLToPath(new URL('../../../../templates/web', import.meta.url))
const gitEnv = {
	GIT_AUTHOR_NAME: 'Mjukvaruhuset build',
	GIT_AUTHOR_EMAIL: 'build@mjukvaruhuset.se',
	GIT_COMMITTER_NAME: 'Mjukvaruhuset build',
	GIT_COMMITTER_EMAIL: 'build@mjukvaruhuset.se',
}
const exists = (path: string) => stat(path).then(() => true, () => false)

const seedRepo = async () => {
	const root = await mkdtemp(join(tmpdir(), 'mf-replay-'))
	const repoDir = join(root, 'repo')
	await mkdir(repoDir, { recursive: true })
	await cp(templateDir, repoDir, {
		recursive: true,
		verbatimSymlinks: true,
		filter: source => {
			if (source === templateDir) return true
			const parts = source.slice(templateDir.length + 1).split('/')
			return parts[0] !== '.git' && !parts.includes('node_modules')
		},
	})
	await exec(
		'bash',
		['-c', `cd "${templateDir}" && find . -maxdepth 3 -name node_modules -type d | while read d; do mkdir -p "${repoDir}/$(dirname "$d")"; cp -al "$d" "${repoDir}/$d"; done`],
		{ cwd: repoDir }
	)
	if (!(await exists(join(repoDir, '.gitignore')))) {
		await writeFile(join(repoDir, '.gitignore'), 'node_modules\ndist\ncoverage\n')
	}
	const run = (args: string[]) => exec('git', args, { cwd: repoDir, env: gitEnv })
	await run(['init', '-q', '-b', 'main'])
	await run(['config', 'core.hooksPath', '/dev/null'])
	await run(['config', 'user.name', gitEnv.GIT_AUTHOR_NAME])
	await run(['config', 'user.email', gitEnv.GIT_AUTHOR_EMAIL])
	await run(['add', '-A'])
	await run(['commit', '-q', '-m', 'chore: seed from template'])
	const seedCommit = (await run(['rev-parse', 'HEAD'])).stdout.trim()
	return { root, repoDir, seedCommit }
}

const jobInput = (repoDir: string, seedCommit: string): JobInput => ({
	id: '01234567-89ab-cdef-0123-456789abcdef',
	spec,
	budget: { maxTokens: 20_000_000, maxDurationMinutes: 30, maxWorkers: 1 },
	repoDir,
	seedCommit,
	delivery: { slug: 'tiny-landing', appName: 'Tiny landing' },
})

const collectEvents = () => {
	const events: NewJobEvent[] = []
	const hooks: RunJobOptions['hooks'] = { emit: async event => void events.push(event), pollIntervalMs: 1_000_000 }
	return { events, hooks }
}

const fixtureDir = fileURLToPath(new URL('../fixtures/cassette', import.meta.url))

let logSpy: ReturnType<typeof vi.spyOn>
let warnSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
	messageSeq = 0
	Object.assign(process.env, gitEnv)
	logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
	warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
	setSessionQuery() // restore the real SDK query
	logSpy.mockRestore()
	warnSpy.mockRestore()
})

// MARK: Record → replay round-trip through the REAL runJob

describe('cassette record/replay e2e', () => {
	it('records one build and replays it through the real runJob with zero model calls', async () => {
		const recDir = await mkdtemp(join(tmpdir(), 'mf-cassette-'))
		const recorded = await seedRepo()
		try {
			// Record: the fakes are the "real" seams; the cassette captures the plan + session streams
			const cassette = await Cassette.open(recDir, 'record')
			const planCreate = vi.fn(() => Promise.resolve(planMessage))
			const querySpy = vi.fn(fakeQuery)
			setSessionQuery(recordQuery(querySpy, cassette))
			const ports = createLivePorts({
				client: recordSpecEngineClient({ messages: { create: planCreate } }, cassette),
				delivery: createFakeDeliveryClients(),
			})
			const outcome = await runJob(jobInput(recorded.repoDir, recorded.seedCommit), {
				ports,
				hooks: collectEvents().hooks,
			})
			expect(outcome.status, outcome.reason).toBe('delivered')
			expect(planCreate).toHaveBeenCalledTimes(1)
			const sessionsRecorded = querySpy.mock.calls.length
			expect(sessionsRecorded).toBeGreaterThan(0)

			// The cassette is a JSONL file: the plan first, then every session
			const lines = (await readFile(join(recDir, 'cassette.jsonl'), 'utf8')).trim().split('\n')
			expect(lines.length).toBe(1 + sessionsRecorded)
			expect(JSON.parse(lines[0]!).t).toBe('plan')
			expect(lines.slice(1).every(line => JSON.parse(line).t === 'session')).toBe(true)

			// Replay: a fresh repo, the cassette is the only source. The underlying fakes are never
			// consulted (their call counts stay flat) — replay is served entirely from the file.
			const replayed = await seedRepo()
			try {
				const play = await Cassette.open(recDir, 'replay')
				setSessionQuery(replayQuery(play))
				const replayPorts = createLivePorts({
					client: replaySpecEngineClient(play),
					delivery: createFakeDeliveryClients(),
				})
				const outcome2 = await runJob(jobInput(replayed.repoDir, replayed.seedCommit), {
					ports: replayPorts,
					hooks: collectEvents().hooks,
				})
				expect(outcome2.status, outcome2.reason).toBe('delivered')
				expect(planCreate).toHaveBeenCalledTimes(1) // no new plan call
				expect(querySpy.mock.calls.length).toBe(sessionsRecorded) // no new session call
				expect(outcome2.gates.map(gate => gate.name)).toEqual(outcome.gates.map(gate => gate.name))
				play.assertDrained()

				// Persist the committed fixture on demand (see docs/TESTING.md)
				if (process.env.MF_WRITE_FIXTURE === '1') {
					await mkdir(fixtureDir, { recursive: true })
					await cp(join(recDir, 'cassette.jsonl'), join(fixtureDir, 'cassette.jsonl'))
				}
			} finally {
				await rm(replayed.root, { recursive: true, force: true })
			}
		} finally {
			await rm(recorded.root, { recursive: true, force: true })
			await rm(recDir, { recursive: true, force: true })
		}
	}, 420_000)

	it('replays the committed cassette fixture through the real runJob, no model, no tokens', async () => {
		if (!(await exists(join(fixtureDir, 'cassette.jsonl')))) {
			throw new Error(`missing committed fixture ${fixtureDir}/cassette.jsonl — regenerate with MF_WRITE_FIXTURE=1`)
		}
		const { root, repoDir, seedCommit } = await seedRepo()
		const delivery: DeliveryClients = createFakeDeliveryClients()
		try {
			const play = await Cassette.open(fixtureDir, 'replay')
			setSessionQuery(replayQuery(play))
			const ports = createLivePorts({ client: replaySpecEngineClient(play), delivery })
			const { events, hooks } = collectEvents()
			const outcome = await runJob(jobInput(repoDir, seedCommit), { ports, hooks })

			expect(outcome.status, outcome.reason).toBe('delivered')
			expect(outcome.gates.every(gate => gate.ok)).toBe(true)
			expect(events.at(-1)?.type).toBe('done')
			const artifacts = delivery.artifacts as FakeArtifactStore
			expect([...artifacts.objects.keys()]).toContain(`deliverables/${jobInput(repoDir, seedCommit).id}/repo.zip`)
			play.assertDrained()
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	}, 420_000)
})

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
	Cassette,
	captureTreeChanges,
	recordQuery,
	recordSpecEngineClient,
	replayQuery,
	replaySpecEngineClient,
	snapshotTree,
	systemHashOf,
} from '#testing/cassette.ts'

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type Anthropic from '@anthropic-ai/sdk'
import type { SpecEngineClient } from '#spec/specEngine.ts'
import type { SessionQuery } from '#job/worker.ts'

// MARK: Fixtures

const message = (id: string): Anthropic.Message =>
	({ id, type: 'message', role: 'assistant', content: [], usage: { input_tokens: 1, output_tokens: 1 } }) as unknown as Anthropic.Message

const result = (extra: Record<string, unknown> = {}): SDKMessage =>
	({ type: 'result', subtype: 'success', is_error: false, result: 'done', ...extra }) as unknown as SDKMessage

const drain = async (query: SessionQuery, systemPrompt: string, cwd: string): Promise<SDKMessage[]> => {
	const out: SDKMessage[] = []
	for await (const m of query({ prompt: 'p', options: { cwd, systemPrompt } as never })) out.push(m)
	return out
}

const withDir = async (fn: (dir: string) => Promise<void>) => {
	const dir = await mkdtemp(join(tmpdir(), 'mf-cassette-'))
	try {
		await fn(dir)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
}

// MARK: Tests

describe('cassette — record', () => {
	it('Appends one JSONL line per interaction, in call order', async () => {
		await withDir(async dir => {
			const cassette = await Cassette.open(dir, 'record')
			await cassette.recordPlan(systemHashOf('plan-system'), { model: 'm' }, message('msg_plan'))
			await cassette.recordSession({
				systemHash: systemHashOf('worker-system'),
				request: { prompt: 'do it' },
				messages: [result()],
				writes: [],
				deletes: [],
			})

			const lines = (await readFile(join(dir, 'cassette.jsonl'), 'utf8')).trim().split('\n')
			expect(lines).toHaveLength(2)
			expect(JSON.parse(lines[0]!)).toMatchObject({ t: 'plan', systemHash: systemHashOf('plan-system') })
			expect(JSON.parse(lines[1]!)).toMatchObject({ t: 'session', request: { prompt: 'do it' } })
		})
	})

	it('Serializes concurrent appends so parallel workers can not interleave a line', async () => {
		await withDir(async dir => {
			const cassette = await Cassette.open(dir, 'record')
			// Each session carries a large body (base64 of a changed file spans several write()
			// syscalls); firing them at once is what interleaves un-serialized appendFile calls.
			const big = 'x'.repeat(256 * 1024)
			const sessions = Array.from({ length: 12 }, (_, i) =>
				cassette.recordSession({
					systemHash: systemHashOf(`worker-${i}`),
					request: { prompt: `task ${i}` },
					messages: [result()],
					writes: [{ path: `changed-${i}.ts`, base64: Buffer.from(big + i).toString('base64') }],
					deletes: [],
				})
			)
			await Promise.all(sessions)

			const lines = (await readFile(join(dir, 'cassette.jsonl'), 'utf8')).trim().split('\n')
			expect(lines).toHaveLength(12)
			// Every line is a whole, valid JSON object — no chunk of one landed inside another.
			const prompts = lines.map(line => (JSON.parse(line) as { request: { prompt: string } }).request.prompt)
			expect(prompts.sort()).toEqual(Array.from({ length: 12 }, (_, i) => `task ${i}`).sort())
		})
	})

	it('systemHashOf is stable and prompt-sensitive, over strings and text blocks', () => {
		expect(systemHashOf('abc')).toBe(systemHashOf('abc'))
		expect(systemHashOf('abc')).not.toBe(systemHashOf('abd'))
		// A system given as the SDK's text-block array hashes to the concatenated text
		expect(systemHashOf([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe(
			systemHashOf('a\nb')
		)
	})
})

describe('cassette — replay', () => {
	it('Matches the next entry per (kind, system hash) in recorded order', async () => {
		await withDir(async dir => {
			const rec = await Cassette.open(dir, 'record')
			// Two plan calls with the SAME system prompt (an invalid-plan retry): FIFO order matters
			await rec.recordPlan(systemHashOf('plan'), { model: 'm' }, message('first'))
			await rec.recordPlan(systemHashOf('plan'), { model: 'm' }, message('second'))

			const play = await Cassette.open(dir, 'replay')
			expect(play.nextPlan(systemHashOf('plan')).response.id).toBe('first')
			expect(play.nextPlan(systemHashOf('plan')).response.id).toBe('second')
			play.assertDrained()
		})
	})

	it('An unexpected (extra) request with no recorded entry is a clear error', async () => {
		await withDir(async dir => {
			const rec = await Cassette.open(dir, 'record')
			await rec.recordSession({ systemHash: systemHashOf('a'), request: { prompt: 'x' }, messages: [], writes: [], deletes: [] })
			const play = await Cassette.open(dir, 'replay')
			play.nextSession(systemHashOf('a'))
			expect(() => play.nextSession(systemHashOf('a'))).toThrow(/no recorded session left/)
			expect(() => play.nextSession(systemHashOf('never-recorded'))).toThrow(/unexpected\/extra request/)
		})
	})

	it('A recorded entry that is never replayed is a clear error (missing request)', async () => {
		await withDir(async dir => {
			const rec = await Cassette.open(dir, 'record')
			await rec.recordPlan(systemHashOf('plan'), { model: 'm' }, message('one'))
			await rec.recordSession({ systemHash: systemHashOf('s'), request: { prompt: 'x' }, messages: [], writes: [], deletes: [] })

			const play = await Cassette.open(dir, 'replay')
			play.nextPlan(systemHashOf('plan'))
			expect(() => play.assertDrained()).toThrow(/1 recorded request\(s\) never replayed/)
		})
	})

	it('Opening a replay cassette in a directory without a file is a clear error', async () => {
		await withDir(async dir => {
			await expect(Cassette.open(dir, 'replay')).rejects.toThrow(/no cassette\.jsonl/)
		})
	})
})

describe('cassette — planner client wrapper', () => {
	it('Records the passed-through response and replays it with no client call', async () => {
		await withDir(async dir => {
			const create = vi.fn(async () => message('planned'))
			const real: SpecEngineClient = { messages: { create } }
			const params = { model: 'plan-model', system: 'the planner system prompt' } as never

			const rec = await Cassette.open(dir, 'record')
			const recorded = await recordSpecEngineClient(real, rec).messages.create(params)
			expect(recorded.id).toBe('planned')
			expect(create).toHaveBeenCalledTimes(1)

			const play = await Cassette.open(dir, 'replay')
			const replayed = await replaySpecEngineClient(play).messages.create(params)
			expect(replayed.id).toBe('planned')
			// The real client is never touched on replay
			expect(create).toHaveBeenCalledTimes(1)
		})
	})
})

describe('cassette — query wrapper (session side effects)', () => {
	it('Records the message stream + working-tree changes and replays both into a fresh tree', async () => {
		await withDir(async recCwd => {
			// A fake "real" session that makes a real edit under cwd and returns a result
			const fakeReal: SessionQuery = async function* (input) {
				await writeFile(join(input.options.cwd!, 'made.ts'), 'export const made = true\n')
				yield result({ structured_output: { findings: [] } })
			}

			const rec = await Cassette.open(recCwd + '.cassette', 'record')
			const recorded = await drain(recordQuery(fakeReal, rec), 'reviewer', recCwd)
			expect((recorded[0] as { structured_output: unknown }).structured_output).toEqual({ findings: [] })
			expect(await readFile(join(recCwd, 'made.ts'), 'utf8')).toContain('made = true')

			// Replay into a DIFFERENT, empty cwd: the edit is re-applied and the stream reproduced
			await withDir(async playCwd => {
				const play = await Cassette.open(recCwd + '.cassette', 'replay')
				const played = await drain(replayQuery(play), 'reviewer', playCwd)
				expect(played).toHaveLength(1)
				expect((played[0] as { structured_output: unknown }).structured_output).toEqual({ findings: [] })
				expect(await readFile(join(playCwd, 'made.ts'), 'utf8')).toBe('export const made = true\n')
				play.assertDrained()
			})
			await rm(recCwd + '.cassette', { recursive: true, force: true })
		})
	})

	it('Replay refuses a recorded write whose path escapes the replay repo', async () => {
		await withDir(async parent => {
			const cwd = join(parent, 'repo')
			await mkdir(cwd, { recursive: true })
			const outside = join(parent, 'outside.txt')
			await writeFile(outside, 'original')

			// A hand-crafted / tampered cassette whose write path climbs out of cwd with `..`.
			const cassetteDir = join(parent, 'cassette')
			await mkdir(cassetteDir, { recursive: true })
			const entry = {
				t: 'session',
				systemHash: systemHashOf('evil'),
				request: { prompt: 'p' },
				messages: [],
				writes: [{ path: '../outside.txt', base64: Buffer.from('pwned').toString('base64') }],
				deletes: [],
			}
			await writeFile(join(cassetteDir, 'cassette.jsonl'), `${JSON.stringify(entry)}\n`)

			const play = await Cassette.open(cassetteDir, 'replay')
			await expect(drain(replayQuery(play), 'evil', cwd)).rejects.toThrow(/outside the replay repo/)
			// The file outside cwd is untouched.
			expect(await readFile(outside, 'utf8')).toBe('original')
		})
	})

	it('Replay refuses a recorded delete whose path escapes the replay repo', async () => {
		await withDir(async parent => {
			const cwd = join(parent, 'repo')
			await mkdir(cwd, { recursive: true })
			const outside = join(parent, 'secret.txt')
			await writeFile(outside, 'keep me')

			const cassetteDir = join(parent, 'cassette')
			await mkdir(cassetteDir, { recursive: true })
			const entry = {
				t: 'session',
				systemHash: systemHashOf('evil'),
				request: { prompt: 'p' },
				messages: [],
				writes: [],
				deletes: ['../secret.txt'],
			}
			await writeFile(join(cassetteDir, 'cassette.jsonl'), `${JSON.stringify(entry)}\n`)

			const play = await Cassette.open(cassetteDir, 'replay')
			await expect(drain(replayQuery(play), 'evil', cwd)).rejects.toThrow(/outside the replay repo/)
			expect(await readFile(outside, 'utf8')).toBe('keep me')
		})
	})

	it('captureTreeChanges reports new/modified files and deletions, skipping node_modules', async () => {
		await withDir(async dir => {
			await mkdir(join(dir, 'node_modules', 'x'), { recursive: true })
			await writeFile(join(dir, 'node_modules', 'x', 'index.js'), 'vendor')
			await writeFile(join(dir, 'keep.ts'), 'a')
			await writeFile(join(dir, 'change.ts'), 'before')
			await writeFile(join(dir, 'gone.ts'), 'b')

			const before = await snapshotTree(dir)

			await writeFile(join(dir, 'change.ts'), 'after')
			await writeFile(join(dir, 'added.ts'), 'new')
			await rm(join(dir, 'gone.ts'))

			const { writes, deletes } = await captureTreeChanges(dir, before)
			expect(writes.map(w => w.path).sort()).toEqual(['added.ts', 'change.ts'])
			expect(deletes).toEqual(['gone.ts'])
			// node_modules is never captured
			expect(writes.some(w => w.path.includes('node_modules'))).toBe(false)
			// The captured body is the current content
			expect(Buffer.from(writes.find(w => w.path === 'change.ts')!.base64, 'base64').toString()).toBe('after')
		})
	})
})

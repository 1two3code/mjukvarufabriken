import { createHash } from 'node:crypto'
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'

import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type Anthropic from '@anthropic-ai/sdk'
import type { SpecEngineClient } from '#spec/specEngine.ts'
import type { SessionQuery } from '#job/worker.ts'

/**
 * Record/replay cassettes over the two model seams a build job reaches out through — the planner's
 * `SpecEngineClient` (`messages.create`) and every worker/merge/gate session's Agent SDK `query()`
 * stream. One live run in `record` mode passes through to the real client/SDK and appends each
 * request + response to a JSONL cassette; an offline run in `replay` mode matches the next request
 * by role + system-prompt hash (order-preserving within a bucket, so parallel tasks with distinct
 * prompts never collide) and returns the recorded response with zero network and zero tokens.
 *
 * A session's response is more than its message stream: the agent's tool calls mutated the working
 * tree, and those edits are the point of the build. So a session entry also carries the files the
 * session changed under its `cwd` (everything outside `node_modules`/`.git`/build output), and
 * replay re-applies them before yielding the recorded messages — the real `runJob` then merges,
 * verifies and gates exactly as it would live. The matcher is deterministic: no clock, no random.
 */

// MARK: Entry shapes

export type CassetteMode = 'record' | 'replay'

export type PlanEntry = {
	t: 'plan'
	systemHash: string
	request: { model: unknown }
	/** The `Anthropic.Message` the planner client returned */
	response: Anthropic.Message
}

export type FileWrite = { path: string; base64: string }

export type SessionEntry = {
	t: 'session'
	systemHash: string
	request: { prompt: string; tools?: readonly string[] }
	/** The SDK message stream, verbatim (assistant usage messages + the final result) */
	messages: SDKMessage[]
	/** Files the session created or changed under `cwd`, replayed before the messages */
	writes: FileWrite[]
	/** Files the session deleted under `cwd` */
	deletes: string[]
}

export type CassetteEntry = PlanEntry | SessionEntry

// MARK: Hashing

const systemText = (system: unknown): string => {
	if (typeof system === 'string') return system
	if (Array.isArray(system)) {
		return system
			.map(block =>
				typeof block === 'string' ? block : ((block as { text?: string }).text ?? '')
			)
			.join('\n')
	}
	return ''
}

/**
 * A system prompt carries a few tokens that legitimately differ between the recorded repo and the
 * replayed one — the review gate embeds its diff range `<seedCommit>..HEAD`, and a run's temp repo
 * path can appear too. Collapsing git SHAs (7–40 hex) and absolute `/tmp`/`/var` paths keeps the
 * hash stable across repos without weakening the match: distinct sessions differ by their spec /
 * task text, never by these tokens alone.
 */
const normalizeForHash = (text: string): string =>
	text
		.replace(/\b[0-9a-f]{7,40}\b/gi, '<sha>')
		.replace(/\/(?:tmp|var|private)\/[^\s'"`)]+/g, '<path>')

/** Stable 16-hex hash of a system prompt — the replay match key. No clock, no random. */
export const systemHashOf = (system: unknown): string =>
	createHash('sha256').update(normalizeForHash(systemText(system))).digest('hex').slice(0, 16)

// MARK: The cassette file

const cassetteFile = (dir: string) => join(dir, 'cassette.jsonl')

/**
 * A cassette backed by a single JSONL file under `dir`. In `record` mode the file is truncated on
 * open and every interaction is appended as it happens. In `replay` mode the file is read once and
 * matched request by request; a request with no recorded entry, and a recorded entry never
 * consumed, are both clear errors (`nextPlan`/`nextSession`, `assertDrained`).
 */
export class Cassette {
	readonly dir: string
	readonly mode: CassetteMode
	private readonly file: string
	// Replay state: ordered entries per (t + systemHash), with a consume cursor.
	private readonly buckets = new Map<string, CassetteEntry[]>()
	private readonly cursor = new Map<string, number>()

	private constructor(dir: string, mode: CassetteMode) {
		this.dir = dir
		this.mode = mode
		this.file = cassetteFile(dir)
	}

	static async open(dir: string, mode: CassetteMode): Promise<Cassette> {
		const cassette = new Cassette(dir, mode)
		if (mode === 'record') {
			await mkdir(dir, { recursive: true })
			await writeFile(cassette.file, '')
		} else {
			await cassette.load()
		}
		return cassette
	}

	private key(t: CassetteEntry['t'], systemHash: string) {
		return `${t}:${systemHash}`
	}

	private async load() {
		let raw: string
		try {
			raw = await readFile(this.file, 'utf8')
		} catch {
			throw new Error(`cassette: no cassette.jsonl in ${this.dir}`)
		}
		for (const line of raw.split('\n')) {
			if (!line.trim()) continue
			const entry = JSON.parse(line) as CassetteEntry
			const key = this.key(entry.t, entry.systemHash)
			const bucket = this.buckets.get(key)
			if (bucket) bucket.push(entry)
			else this.buckets.set(key, [entry])
		}
	}

	private async append(entry: CassetteEntry) {
		await appendFile(this.file, `${JSON.stringify(entry)}\n`)
	}

	// MARK: record

	async recordPlan(systemHash: string, request: PlanEntry['request'], response: Anthropic.Message) {
		await this.append({ t: 'plan', systemHash, request, response })
	}

	async recordSession(entry: Omit<SessionEntry, 't'>) {
		await this.append({ t: 'session', ...entry })
	}

	// MARK: replay

	private next<E extends CassetteEntry>(t: E['t'], systemHash: string, label: string): E {
		const key = this.key(t, systemHash)
		const bucket = this.buckets.get(key) ?? []
		const at = this.cursor.get(key) ?? 0
		const entry = bucket[at]
		if (!entry) {
			const seen = [...this.buckets.keys()].join(', ') || '(empty cassette)'
			throw new Error(
				`cassette: no recorded ${label} left for system hash ${systemHash} (unexpected/extra request). Recorded buckets: ${seen}`
			)
		}
		this.cursor.set(key, at + 1)
		return entry as E
	}

	nextPlan(systemHash: string): PlanEntry {
		return this.next<PlanEntry>('plan', systemHash, 'plan')
	}

	nextSession(systemHash: string): SessionEntry {
		return this.next<SessionEntry>('session', systemHash, 'session')
	}

	/** Throws when the replay left recorded entries unconsumed (a request went missing) */
	assertDrained() {
		const missing: string[] = []
		for (const [key, bucket] of this.buckets) {
			const at = this.cursor.get(key) ?? 0
			if (at < bucket.length) missing.push(`${key} (${bucket.length - at} of ${bucket.length})`)
		}
		if (missing.length) {
			throw new Error(`cassette: ${missing.length} recorded request(s) never replayed: ${missing.join(', ')}`)
		}
	}
}

// MARK: Working-tree capture (session side effects)

const skipDirs = new Set(['node_modules', '.git', 'dist', 'coverage', 'cdk.out'])

/** Every file under `dir` (excluding build/vendor dirs), as a `relative path → sha256` map */
export const snapshotTree = async (dir: string): Promise<Map<string, string>> => {
	const files = new Map<string, string>()
	const walk = async (current: string) => {
		let entries
		try {
			entries = await readdir(current, { withFileTypes: true })
		} catch {
			return
		}
		for (const entry of entries) {
			if (entry.isSymbolicLink()) continue
			if (entry.isDirectory()) {
				if (skipDirs.has(entry.name)) continue
				await walk(join(current, entry.name))
			} else if (entry.isFile()) {
				const full = join(current, entry.name)
				const body = await readFile(full).catch(() => undefined)
				if (body) files.set(relative(dir, full), createHash('sha256').update(body).digest('hex'))
			}
		}
	}
	await walk(dir)
	return files
}

/** What changed under `cwd` between two snapshots: new/modified files (with content) + deletions */
export const captureTreeChanges = async (
	cwd: string,
	before: Map<string, string>
): Promise<{ writes: FileWrite[]; deletes: string[] }> => {
	const after = await snapshotTree(cwd)
	const writes: FileWrite[] = []
	for (const [path, hash] of after) {
		if (before.get(path) !== hash) {
			const body = await readFile(join(cwd, path))
			writes.push({ path, base64: body.toString('base64') })
		}
	}
	const deletes = [...before.keys()].filter(path => !after.has(path))
	return { writes, deletes }
}

const applyTreeChanges = async (cwd: string, writes: FileWrite[], deletes: string[]) => {
	for (const del of deletes) await rm(join(cwd, del), { force: true }).catch(() => {})
	for (const write of writes) {
		const full = join(cwd, ...write.path.split(/[\\/]/))
		await mkdir(dirname(full), { recursive: true })
		await writeFile(full, Buffer.from(write.base64, 'base64'))
	}
}

// MARK: Planner (SpecEngineClient) wrappers

/** Wrap the real planner client so each `messages.create` is passed through and recorded */
export const recordSpecEngineClient = (
	real: SpecEngineClient,
	cassette: Cassette
): SpecEngineClient => ({
	messages: {
		create: async (params, options) => {
			const response = await real.messages.create(params, options)
			await cassette.recordPlan(systemHashOf(params.system), { model: params.model }, response)
			return response
		},
	},
})

/** A planner client that answers from the cassette — no network */
export const replaySpecEngineClient = (cassette: Cassette): SpecEngineClient => ({
	messages: {
		create: async params => cassette.nextPlan(systemHashOf(params.system)).response,
	},
})

// MARK: Session (query) wrappers

/**
 * Wrap the real Agent SDK `query` so each session's message stream is tee'd into the cassette and
 * the files it changed under `cwd` are captured after it completes.
 */
export const recordQuery = (real: SessionQuery, cassette: Cassette): SessionQuery =>
	async function* recording(input) {
		const cwd = sessionCwd(input.options)
		const before = await snapshotTree(cwd)
		const messages: SDKMessage[] = []
		for await (const message of real(input)) {
			messages.push(message)
			yield message
		}
		const { writes, deletes } = await captureTreeChanges(cwd, before)
		await cassette.recordSession({
			systemHash: systemHashOf(input.options.systemPrompt),
			request: { prompt: input.prompt, tools: sessionTools(input.options) },
			messages,
			writes,
			deletes,
		})
	}

/**
 * A `query` that answers from the cassette: it re-applies the recorded session's file changes to
 * `cwd`, then yields the recorded messages. No SDK, no subprocess, no network.
 */
export const replayQuery = (cassette: Cassette): SessionQuery =>
	async function* replaying(input) {
		const entry = cassette.nextSession(systemHashOf(input.options.systemPrompt))
		await applyTreeChanges(sessionCwd(input.options), entry.writes, entry.deletes)
		for (const message of entry.messages) yield message
	}

const sessionCwd = (options: Options): string => {
	if (!options.cwd) throw new Error('cassette: a session was started without a cwd')
	return options.cwd
}

const sessionTools = (options: Options): readonly string[] | undefined =>
	Array.isArray(options.allowedTools) ? options.allowedTools : undefined

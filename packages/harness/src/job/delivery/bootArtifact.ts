import { spawn } from 'node:child_process'
import { access, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { killProcessGroup, launch, sandboxEnv, tail } from '#job/exec.ts'

import type { ChildProcess } from 'node:child_process'
import type { BootCheck } from './types.ts'

/**
 * !!! The overarching lesson of the family-hub #2 salvage: in-process green != the artifact boots.
 *
 * The gates run lint + vitest, which wrap CJS/ESM interop (esbuild) and never boot the real
 * server, so an env-contract mismatch (a plugin that throws without `AUTH_JWT_SECRET`) or a
 * named ESM import of a CJS-only dep (`import { RRule } from 'rrule'`) passes every in-process
 * check and then crashloops `node src/index.ts` in the container → 503. This smoke-boots the
 * BUILT artifact with its runtime env and asserts it reaches "Server listening" before delivery
 * stands up a service — catching exactly those crashes in seconds.
 */

// MARK: Ready detection

/** The line Fastify prints once the server is up (`server.listen` → "Server listening at …") */
export const defaultReadyPattern = /Server listening/i

// MARK: Boot target

/** The server entry the delivered container runs by default (`node <entry>`); the template api's */
export const serverEntry = 'apps/api/src/index.ts'

const exists = async (path: string) => {
	try {
		await access(path)
		return true
	} catch {
		return false
	}
}

/** File extensions Node can run directly (`.ts` via type-stripping) — a start-script entry must be one */
const runnableExtensions = ['.ts', '.mts', '.cts', '.mjs', '.cjs', '.js']
const isRunnableEntry = (token: string) => runnableExtensions.some(extension => token.endsWith(extension))

/**
 * The server entry named by the repo's root `package.json` `start` script, when it runs a file
 * that exists on disk (`"start": "node apps/server/src/index.ts"`, `"node dist/index.js"`, …). The
 * first token of the script that looks runnable and exists wins; node flags and non-existent paths
 * are skipped. Returns undefined when there is no package.json, no start script, or its entry is
 * absent (e.g. `npm run -w …` indirection) — the caller then scans the apps.
 */
const startScriptEntry = async (repoDir: string): Promise<string | undefined> => {
	let start: string | undefined
	try {
		const pkg = JSON.parse(await readFile(join(repoDir, 'package.json'), 'utf8')) as {
			scripts?: Record<string, string>
		}
		start = pkg.scripts?.start
	} catch {
		return undefined
	}
	if (!start) return undefined
	for (const token of start.split(/\s+/)) {
		if (isRunnableEntry(token) && (await exists(join(repoDir, token)))) return token
	}
	return undefined
}

/**
 * The first `apps/<app>/src/index.ts` that exists, preferring an app literally named `api` (the
 * template's), then any other app — so a generated app that renamed its api (`apps/server`, …)
 * still boots. Returns undefined when there is no `apps/` dir or no such entry (a static site).
 */
const scanAppEntries = async (repoDir: string): Promise<string | undefined> => {
	let apps: string[]
	try {
		apps = (await readdir(join(repoDir, 'apps'), { withFileTypes: true }))
			.filter(entry => entry.isDirectory())
			.map(entry => entry.name)
	} catch {
		return undefined
	}
	const ordered = [...apps].sort((a, b) => (a === 'api' ? -1 : b === 'api' ? 1 : a.localeCompare(b)))
	for (const app of ordered) {
		const entry = join('apps', app, 'src', 'index.ts')
		if (await exists(join(repoDir, entry))) return entry
	}
	return undefined
}

/** The real server entry (relative to `repoDir`), or undefined when the repo has no server to boot */
export const serverEntryOf = async (repoDir: string): Promise<string | undefined> => {
	const fromStart = await startScriptEntry(repoDir)
	if (fromStart) return fromStart
	const fromScan = await scanAppEntries(repoDir)
	if (fromScan) return fromScan
	return (await exists(join(repoDir, serverEntry))) ? serverEntry : undefined
}

/**
 * The command that boots the built server, or `undefined` when the repo has no server to boot
 * (a purely static site). Finds the real entry from the repo's `start` script or by scanning
 * `apps/<app>/src/index.ts` (not only the fixed template path), so a generated app that renamed its
 * api still smoke-boots.
 */
export const resolveBootTarget = async (
	repoDir: string
): Promise<{ command: string; args: string[] } | undefined> => {
	const entry = await serverEntryOf(repoDir)
	return entry ? { command: process.execPath, args: [entry] } : undefined
}

// MARK: Boot primitive

export type BootArtifactInput = {
	cwd: string
	command: string
	args: string[]
	/** Runtime env the server needs to boot (auth contract, generated secrets, …) */
	env?: Record<string, string>
	/** stdout/stderr match that means the server booted (default `Server listening`) */
	readyPattern?: RegExp
	/** Give up (and report a failure) after this many ms (default 60 s) */
	timeoutMs?: number
	signal?: AbortSignal
	/** Injectable for tests (default: `child_process.spawn`) */
	spawnFn?: typeof spawn
}

export type BootResult = { ok: boolean; output: string; reason?: string }

const bootReason = (result: Omit<BootResult, 'reason'>, extra: string) =>
	tail(`${extra}${result.output ? `\n${result.output}` : ''}`, 40)

/**
 * Boots `command args` in `cwd` with `env` and resolves as soon as its output matches
 * `readyPattern` (ok), or when it exits first (a crash — its exit code + last output), or the
 * timeout elapses (never came up). The process (and its group) is always killed before resolving,
 * so a booted server is not left running. Runs sandboxed like every other customer-repo command.
 */
export const bootArtifact = ({
	cwd,
	command,
	args,
	env = {},
	readyPattern = defaultReadyPattern,
	timeoutMs = 60_000,
	signal,
	spawnFn = spawn,
}: BootArtifactInput): Promise<BootResult> =>
	new Promise(resolve => {
		if (signal?.aborted) return resolve({ ok: false, output: '', reason: 'aborted' })
		const launched = launch(command, args, { asWorker: true })
		const child: ChildProcess = spawnFn(launched.command, launched.args, {
			cwd,
			// The boot env is applied last so the app's required runtime env wins over the sandbox base
			env: { ...sandboxEnv(), PORT: '8080', ADDRESS: '0.0.0.0', HOST: '0.0.0.0', ...env },
			stdio: ['ignore', 'pipe', 'pipe'],
			detached: true,
		})
		let output = ''
		let settled = false
		const finish = (result: BootResult) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			signal?.removeEventListener('abort', onAbort)
			killProcessGroup(child.pid)
			resolve(result)
		}
		const onData = (chunk: unknown) => {
			output += String(chunk)
			if (readyPattern.test(output)) finish({ ok: true, output })
		}
		const onAbort = () => finish({ ok: false, output, reason: 'aborted' })
		const timer = setTimeout(
			() =>
				finish({
					ok: false,
					output,
					reason: bootReason({ ok: false, output }, `did not reach "${readyPattern.source}" in ${timeoutMs} ms`),
				}),
			timeoutMs
		)
		signal?.addEventListener('abort', onAbort, { once: true })
		child.stdout?.on('data', onData)
		child.stderr?.on('data', onData)
		child.on('error', error =>
			finish({ ok: false, output, reason: `spawn failed: ${(error as Error).message}` })
		)
		child.on('exit', code =>
			finish(
				readyPattern.test(output)
					? { ok: true, output }
					: {
							ok: false,
							output,
							reason: bootReason({ ok: false, output }, `server exited (code ${code ?? 'null'}) before it started`),
						}
			)
		)
	})

// MARK: Clients

/**
 * !!! LIVE-UNVERIFIED — spawns the built repo's server, never exercised by a test. !!!
 *
 * The delivery `BootCheck` that boots the built repo's real server entry (`resolveBootTarget`:
 * the `start` script or a scanned `apps/<app>/src/index.ts`, not only the template path). A repo with
 * no server entry (a static-only delivery) is a pass — there is nothing to crash. The required
 * runtime env is passed in by delivery, resolved from the app's own env manifest (generated app
 * secrets + auth contract + placeholders), so an app requiring arbitrary secrets boots here too.
 */
export const createNodeBootCheck = (
	options: { readyPattern?: RegExp; timeoutMs?: number } = {}
): BootCheck => ({
	boot: async ({ repoDir, env, signal }) => {
		const target = await resolveBootTarget(repoDir)
		if (!target) return { ok: true, output: '', reason: 'no server entry to boot (static delivery)' }
		return bootArtifact({ cwd: repoDir, ...target, env, signal, ...options })
	},
})

/** In-memory boot check for the unit tests: records every call, returns a canned result */
export type FakeBootCheck = BootCheck & {
	calls: { repoDir: string; env: Record<string, string> }[]
}

export const createFakeBootCheck = (result: BootResult = { ok: true, output: 'Server listening' }): FakeBootCheck => {
	const fake: FakeBootCheck = {
		calls: [],
		boot: async ({ repoDir, env }) => {
			fake.calls.push({ repoDir, env })
			return result
		},
	}
	return fake
}

/** Dry-run boot check: logs and passes without spawning anything */
export const createDryRunBootCheck = (log: (line: string) => void): BootCheck => ({
	boot: async ({ repoDir }) => {
		log(`[dry-run] boot artifact: node ${serverEntry} in ${repoDir}`)
		return { ok: true, output: '', reason: 'dry-run: not booted' }
	},
})

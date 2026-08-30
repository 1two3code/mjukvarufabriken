import { spawn } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { killProcessGroup, launch, sandboxEnv, tail } from '#job/exec.ts'

import { defaultReadyPattern, resolveBootTarget } from './bootArtifact.ts'

import type { ChildProcess } from 'node:child_process'
import type { BootCheck } from './types.ts'

/**
 * !!! The next lesson after bootArtifact: the artifact BOOTING still does not prove the delivered
 * app WORKS. job 486113ca (guestbook) passed all five gates — including acceptance-check "with
 * evidence" — and booted fine, yet was dead in a browser: the built SPA (baseUrl `/bff`) called
 * `POST /bff/guestbook`, but the worker had registered the route at `/guestbook`, so every request
 * 404'd. The acceptance tests MOCK the network boundary (RTK Query mocked), so a frontend↔backend
 * contract mismatch is invisible to them.
 *
 * This wires the two halves together: boot the real server, then replay the requests the built
 * frontend actually makes (its `VITE_API_URL` base + the endpoint paths in its RTK-Query slices)
 * and fail if any resolves to a 404 — the deterministic signature of a route the SPA needs but the
 * backend does not serve. 401/400/500 all mean the route EXISTS (auth / validation / a bug), which
 * this check deliberately does not judge; only "the path is not registered at all" is a wiring
 * defect it can prove without a browser.
 */

// MARK: Frontend API surface (pure extraction)

export type ApiCall = { method: string; path: string }
export type FrontendApiSurface = { base: string; calls: ApiCall[] }

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])

/** Reads `KEY=value` from a dotenv file's text (last assignment wins), trimming quotes/space. */
export const readEnvValue = (content: string | undefined, key: string): string | undefined => {
	if (!content) return undefined
	let value: string | undefined
	for (const line of content.split(/\r?\n/)) {
		const trimmed = line.trim()
		if (trimmed.startsWith('#') || !trimmed.startsWith(`${key}=`)) continue
		value = trimmed.slice(key.length + 1).trim().replace(/^['"]|['"]$/g, '')
	}
	return value
}

/**
 * The API base the built SPA prepends to every call (`VITE_API_URL`). An absolute value is reduced
 * to its path — the delivered container serves the api on the same origin, so we probe the path on
 * our own boot origin. A trailing slash is dropped so `${base}${path}` never doubles it.
 */
export const parseViteApiBase = (raw: string | undefined): string | undefined => {
	const value = raw?.trim()
	if (!value) return undefined
	const path = value.startsWith('http')
		? (() => {
				try {
					return new URL(value).pathname
				} catch {
					return value
				}
			})()
		: value
	return path === '/' ? '' : path.replace(/\/$/, '')
}

/** Keep only fully-static absolute API paths; skip interpolated / concatenated / collection-prefix ones. */
const isProbablePath = (literal: string) =>
	literal.startsWith('/') && !literal.includes('${') && !literal.includes('+') && !literal.endsWith('/')

const addCall = (calls: ApiCall[], method: string, literal: string) => {
	if (!isProbablePath(literal)) return
	const normalisedMethod = HTTP_METHODS.has(method.toUpperCase()) ? method.toUpperCase() : 'GET'
	if (!calls.some(call => call.method === normalisedMethod && call.path === literal)) {
		calls.push({ method: normalisedMethod, path: literal })
	}
}

/**
 * The API paths (+ methods) an RTK-Query slice calls, from its two common endpoint shapes:
 *   query: () => '/things'                              → GET /things
 *   query: body => ({ url: '/things', method: 'POST' }) → POST /things
 * Interpolated (`/things/${id}`) and concatenated paths are skipped to avoid false 404s; the
 * regexes never match across the file because the string literal terminates them.
 */
export const extractApiCalls = (source: string): ApiCall[] => {
	const calls: ApiCall[] = []
	// query: (...) => '<path>'  — an arrow returning a bare string literal is a GET
	for (const match of source.matchAll(/query:\s*\([^)]*\)\s*=>\s*['"`]([^'"`]*)['"`]/g)) {
		addCall(calls, 'GET', match[1])
	}
	// url: '<path>'  — inside an endpoint object; take method: from the same object window
	for (const match of source.matchAll(/url:\s*['"`]([^'"`]*)['"`]/g)) {
		const window = source.slice(match.index ?? 0, (match.index ?? 0) + 200)
		const method = window.match(/method:\s*['"`](\w+)['"`]/)?.[1] ?? 'GET'
		addCall(calls, method, match[1])
	}
	return calls
}

// MARK: Frontend API surface (filesystem)

const readIfExists = async (path: string): Promise<string | undefined> => {
	try {
		return await readFile(path, 'utf8')
	} catch {
		return undefined
	}
}

/** Recursively collect `.ts`/`.tsx` files under `dir` that reference RTK Query (the api slices). */
const collectApiSliceFiles = async (dir: string): Promise<string[]> => {
	let entries
	try {
		entries = await readdir(dir, { withFileTypes: true })
	} catch {
		return []
	}
	const files: string[] = []
	for (const entry of entries) {
		const full = join(dir, entry.name)
		if (entry.isDirectory()) {
			if (entry.name === 'node_modules') continue
			files.push(...(await collectApiSliceFiles(full)))
		} else if (/\.tsx?$/.test(entry.name)) {
			const content = await readIfExists(full)
			if (content && /createApi|injectEndpoints|fetchBaseQuery|@reduxjs\/toolkit\/query/.test(content)) {
				files.push(full)
			}
		}
	}
	return files
}

/** The apps/ dir that holds the built SPA — prefer `app`, else the first with an `index.html`. */
export const findFrontendAppDir = async (repoDir: string): Promise<string | undefined> => {
	const appsDir = join(repoDir, 'apps')
	let apps
	try {
		apps = (await readdir(appsDir, { withFileTypes: true }))
			.filter(entry => entry.isDirectory())
			.map(entry => entry.name)
	} catch {
		return undefined
	}
	const ordered = [...apps].sort((a, b) => (a === 'app' ? -1 : b === 'app' ? 1 : a.localeCompare(b)))
	for (const app of ordered) {
		if (await readIfExists(join(appsDir, app, 'index.html'))) return join(appsDir, app)
	}
	return undefined
}

/**
 * The built frontend's HTTP surface: its `VITE_API_URL` base (the delivered build is mode `live`,
 * so `.env.live` overrides `.env`) plus the static endpoint calls in its RTK-Query slices. Returns
 * undefined when there is no SPA or no `VITE_API_URL` to anchor the probes against.
 */
export const extractFrontendApiSurface = async (
	repoDir: string
): Promise<FrontendApiSurface | undefined> => {
	const appDir = await findFrontendAppDir(repoDir)
	if (!appDir) return undefined
	const baseEnv = await readIfExists(join(appDir, '.env'))
	const liveEnv = await readIfExists(join(appDir, '.env.live'))
	const base = parseViteApiBase(
		readEnvValue(liveEnv, 'VITE_API_URL') ?? readEnvValue(baseEnv, 'VITE_API_URL')
	)
	if (base === undefined) return undefined
	const calls: ApiCall[] = []
	for (const file of await collectApiSliceFiles(join(appDir, 'src'))) {
		for (const call of extractApiCalls((await readIfExists(file)) ?? '')) {
			if (!calls.some(existing => existing.method === call.method && existing.path === call.path)) {
				calls.push(call)
			}
		}
	}
	return { base, calls }
}

// MARK: Probe + evaluate (pure over an injected fetch)

export type ProbeResult = ApiCall & { status: number }
export type FetchLike = (url: string, init: { method: string }) => Promise<{ status: number }>

/** Replays each frontend call against the booted origin; a connection error is status 0 (ignored). */
export const probeApiSurface = async (
	origin: string,
	surface: FrontendApiSurface,
	fetchFn: FetchLike = fetch
): Promise<ProbeResult[]> => {
	const results: ProbeResult[] = []
	for (const call of surface.calls) {
		try {
			const { status } = await fetchFn(`${origin}${surface.base}${call.path}`, { method: call.method })
			results.push({ ...call, status })
		} catch {
			results.push({ ...call, status: 0 })
		}
	}
	return results
}

/** A frontend call is a wiring defect only when the route is not registered at all (404). */
export const wiringFailures = (results: ProbeResult[]): ProbeResult[] =>
	results.filter(result => result.status === 404)

export const wiredSmokeReason = (base: string, failures: ProbeResult[]): string =>
	`the built frontend calls ${failures.length} endpoint(s) the backend does not serve (404): ` +
	`${failures.map(failure => `${failure.method} ${base}${failure.path}`).join(', ')} — the SPA is ` +
	`wired (VITE_API_URL=${base || '/'}) to routes that are not registered; check the API prefix / route paths.`

// MARK: Boot-and-hold (keeps the server up so it can be probed, then kills it)

export type HeldServer = {
	ok: boolean
	output: string
	reason?: string
	origin?: string
	kill?: () => void
}

export type BootAndHoldInput = {
	cwd: string
	command: string
	args: string[]
	env?: Record<string, string>
	readyPattern?: RegExp
	timeoutMs?: number
	signal?: AbortSignal
	spawnFn?: typeof spawn
}

const HELD_PORT = '8080'

/**
 * Like bootArtifact, but on "Server listening" it resolves WITHOUT killing — the caller probes the
 * live server on `origin` then calls `kill()`. A crash/timeout kills the process and resolves ok:false.
 */
export const bootAndHold = ({
	cwd,
	command,
	args,
	env = {},
	readyPattern = defaultReadyPattern,
	timeoutMs = 60_000,
	signal,
	spawnFn = spawn,
}: BootAndHoldInput): Promise<HeldServer> =>
	new Promise(resolve => {
		if (signal?.aborted) return resolve({ ok: false, output: '', reason: 'aborted' })
		const launched = launch(command, args, { asWorker: true })
		const child: ChildProcess = spawnFn(launched.command, launched.args, {
			cwd,
			env: { ...sandboxEnv(), PORT: HELD_PORT, ADDRESS: '0.0.0.0', HOST: '0.0.0.0', ...env },
			stdio: ['ignore', 'pipe', 'pipe'],
			detached: true,
		})
		let output = ''
		let settled = false
		const kill = () => killProcessGroup(child.pid)
		const settle = (result: HeldServer) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			signal?.removeEventListener('abort', onAbort)
			resolve(result)
		}
		const onData = (chunk: unknown) => {
			output += String(chunk)
			if (readyPattern.test(output)) settle({ ok: true, output, origin: `http://127.0.0.1:${HELD_PORT}`, kill })
		}
		const onAbort = () => {
			kill()
			settle({ ok: false, output, reason: 'aborted' })
		}
		const timer = setTimeout(() => {
			kill()
			settle({
				ok: false,
				output,
				reason: tail(`did not reach "${readyPattern.source}" in ${timeoutMs} ms\n${output}`, 40),
			})
		}, timeoutMs)
		signal?.addEventListener('abort', onAbort, { once: true })
		child.stdout?.on('data', onData)
		child.stderr?.on('data', onData)
		child.on('error', error => settle({ ok: false, output, reason: `spawn failed: ${(error as Error).message}` }))
		child.on('exit', code => {
			if (!readyPattern.test(output)) {
				settle({
					ok: false,
					output,
					reason: tail(`server exited (code ${code ?? 'null'}) before it started\n${output}`, 40),
				})
			}
		})
	})

// MARK: The BootCheck

export type WiredSmokeOptions = {
	readyPattern?: RegExp
	timeoutMs?: number
	/** Injectable for tests (default: the real boot-and-hold / global fetch) */
	bootFn?: (input: BootAndHoldInput) => Promise<HeldServer>
	fetchFn?: FetchLike
}

/**
 * !!! LIVE-UNVERIFIED end to end (spawns the built server); the extraction, probing and evaluation
 * are covered by unit + real-http-server tests. !!!
 *
 * The delivery BootCheck that boots the built server AND verifies the built frontend's calls
 * resolve. No server entry (static delivery) or no discoverable frontend surface is a pass — there
 * is nothing to wire. A boot failure passes through as-is; a wiring mismatch fails the check with
 * the offending endpoints, so delivery skips the deploy rather than shipping a dead-in-browser app.
 */
export const createWiredSmokeCheck = ({
	bootFn = bootAndHold,
	fetchFn = fetch,
	...bootOptions
}: WiredSmokeOptions = {}): BootCheck => ({
	boot: async ({ repoDir, env, signal }) => {
		const target = await resolveBootTarget(repoDir)
		if (!target) return { ok: true, output: '', reason: 'no server entry to boot (static delivery)' }
		const held = await bootFn({ cwd: repoDir, ...target, env, signal, ...bootOptions })
		if (!held.ok || !held.origin || !held.kill) {
			return { ok: held.ok, output: held.output, reason: held.reason }
		}
		try {
			const surface = await extractFrontendApiSurface(repoDir)
			if (!surface || surface.calls.length === 0) {
				return { ok: true, output: held.output, reason: 'booted; no static frontend API calls to verify' }
			}
			const results = await probeApiSurface(held.origin, surface, fetchFn)
			const failures = wiringFailures(results)
			return failures.length
				? { ok: false, output: held.output, reason: wiredSmokeReason(surface.base, failures) }
				: { ok: true, output: held.output, reason: `booted; ${results.length} frontend endpoint(s) resolve` }
		} finally {
			held.kill()
		}
	},
})

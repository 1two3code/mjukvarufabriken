import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
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

/** The server entry the delivered container runs (`node <entry>`); the template api's `src/index.ts` */
export const serverEntry = 'apps/api/src/index.ts'

const exists = async (path: string) => {
	try {
		await access(path)
		return true
	} catch {
		return false
	}
}

/**
 * The command that boots the built server, or `undefined` when the repo has no server to boot
 * (a purely static site delivered without an api). Only the template's `apps/api/src/index.ts`
 * is recognised today; a generated app that renamed its entry needs the env/boot manifest (TODO).
 */
export const resolveBootTarget = async (
	repoDir: string
): Promise<{ command: string; args: string[] } | undefined> =>
	(await exists(join(repoDir, serverEntry)))
		? { command: process.execPath, args: [serverEntry] }
		: undefined

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
			env: { ...sandboxEnv(), PORT: '8080', HOST: '0.0.0.0', ...env },
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
 * The delivery `BootCheck` that boots `apps/api/src/index.ts` of the built repo. A repo with no
 * server entry (a static-only delivery) is a pass — there is nothing to crash. The required
 * runtime env is passed in by delivery (today: the preview auth contract only — the full
 * app-declared env manifest is a follow-up, TODO).
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

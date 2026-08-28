import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
	bootArtifact,
	createFakeBootCheck,
	createNodeBootCheck,
	resolveBootTarget,
	serverEntry,
} from '#job/delivery/bootArtifact.ts'

import type { spawn } from 'node:child_process'

// MARK: Fake spawn

/** A minimal `ChildProcess` stand-in whose stdout/stderr/exit the test drives by hand */
class FakeChild extends EventEmitter {
	stdout = new EventEmitter()
	stderr = new EventEmitter()
	// `undefined` so `killProcessGroup` is a no-op — the test never signals a real process group
	pid = undefined
	emitOut(chunk: string) {
		this.stdout.emit('data', chunk)
	}
	emitErr(chunk: string) {
		this.stderr.emit('data', chunk)
	}
	exit(code: number | null) {
		this.emit('exit', code)
	}
	fail(error: Error) {
		this.emit('error', error)
	}
}

type SpawnCall = { command: string; args: string[]; options: Record<string, unknown> }

const fakeSpawn = () => {
	const calls: SpawnCall[] = []
	const child = new FakeChild()
	const spawnFn = ((command: string, args: string[], options: Record<string, unknown>) => {
		calls.push({ command, args, options })
		return child
	}) as unknown as typeof spawn
	return { spawnFn, calls, child }
}

const flush = () => new Promise(resolve => setImmediate(resolve))

// MARK: Tests

describe('bootArtifact', () => {
	it('Resolves ok as soon as the ready line appears on stdout', async () => {
		// Arrange
		const { spawnFn, child, calls } = fakeSpawn()
		const pending = bootArtifact({
			cwd: '/repo',
			command: 'node',
			args: ['apps/api/src/index.ts'],
			env: { AUTH_ISSUER: 'https://idp' },
			spawnFn,
		})

		// Act — the app boots and prints Fastify's ready line
		await flush()
		child.emitOut('some startup noise\n')
		child.emitOut('Server listening at http://0.0.0.0:8080\n')

		// Assert
		const result = await pending
		expect(result.ok).toBe(true)
		expect(result.output).toContain('Server listening')
		// The required runtime env (and a default PORT) reached the process
		expect(calls[0]!.options.env).toMatchObject({ AUTH_ISSUER: 'https://idp', PORT: '8080' })
	})

	it('Detects the ready line on stderr too', async () => {
		const { spawnFn, child } = fakeSpawn()
		const pending = bootArtifact({ cwd: '/repo', command: 'node', args: ['x.ts'], spawnFn })
		await flush()
		child.emitErr('Server listening at http://0.0.0.0:8080\n')
		expect((await pending).ok).toBe(true)
	})

	it('Fails when the process crashes before it starts (env-contract / CJS-ESM crash)', async () => {
		// Arrange
		const { spawnFn, child } = fakeSpawn()
		const pending = bootArtifact({ cwd: '/repo', command: 'node', args: ['x.ts'], spawnFn })

		// Act — the real family-hub #2 crash shape: a boot-time throw, then exit 1
		await flush()
		child.emitErr("SyntaxError: does not provide an export named 'RRule'\n")
		child.exit(1)

		// Assert
		const result = await pending
		expect(result.ok).toBe(false)
		expect(result.reason).toContain('exited')
		expect(result.reason).toContain("named 'RRule'")
	})

	it('Fails when the ready line never comes within the timeout', async () => {
		// Arrange — a short timeout, and a process that just hangs
		const { spawnFn, child } = fakeSpawn()
		const pending = bootArtifact({
			cwd: '/repo',
			command: 'node',
			args: ['x.ts'],
			timeoutMs: 20,
			spawnFn,
		})

		// Act
		await flush()
		child.emitOut('booting…\n')

		// Assert
		const result = await pending
		expect(result.ok).toBe(false)
		expect(result.reason).toContain('did not reach')
	})

	it('Fails fast when the signal is already aborted (never spawns)', async () => {
		const { spawnFn, calls } = fakeSpawn()
		const controller = new AbortController()
		controller.abort()
		const result = await bootArtifact({
			cwd: '/repo',
			command: 'node',
			args: ['x.ts'],
			signal: controller.signal,
			spawnFn,
		})
		expect(result).toEqual({ ok: false, output: '', reason: 'aborted' })
		expect(calls).toHaveLength(0)
	})

	it('Reports a spawn error instead of throwing', async () => {
		const { spawnFn, child } = fakeSpawn()
		const pending = bootArtifact({ cwd: '/repo', command: 'node', args: ['x.ts'], spawnFn })
		await flush()
		child.fail(new Error('ENOENT: node not found'))
		const result = await pending
		expect(result.ok).toBe(false)
		expect(result.reason).toContain('spawn failed')
	})
})

// MARK: Target resolution + clients

describe('boot target + clients', () => {
	let root: string
	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'mf-boot-'))
	})
	afterEach(() => rm(root, { recursive: true, force: true }))

	it('Resolves the template server entry when present', async () => {
		await mkdir(join(root, 'apps/api/src'), { recursive: true })
		await writeFile(join(root, serverEntry), 'console.log("Server listening")\n')
		const target = await resolveBootTarget(root)
		expect(target?.args).toEqual([serverEntry])
	})

	it('Resolves no target for a static delivery (no server entry) → the boot check passes', async () => {
		expect(await resolveBootTarget(root)).toBeUndefined()
		const boot = createNodeBootCheck()
		const result = await boot.boot({ repoDir: root, env: {} })
		expect(result.ok).toBe(true)
		expect(result.reason).toContain('static')
	})

	it('The fake boot check records its calls and returns the canned result', async () => {
		const boot = createFakeBootCheck({ ok: false, output: '', reason: 'boom' })
		const result = await boot.boot({ repoDir: '/repo', env: { AUTH_ISSUER: 'x' } })
		expect(result).toEqual({ ok: false, output: '', reason: 'boom' })
		expect(boot.calls).toEqual([{ repoDir: '/repo', env: { AUTH_ISSUER: 'x' } }])
	})
})

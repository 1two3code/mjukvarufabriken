import { installCrashHandlers } from '#/crash.ts'

import type { CrashEvent, CrashTarget } from '#/crash.ts'

const fakeTarget = () => {
	const listeners = new Map<CrashEvent, (error: unknown) => void>()
	const target: CrashTarget = {
		on: (event, listener) => listeners.set(event, listener),
	}
	return { target, fire: (event: CrashEvent, error?: unknown) => listeners.get(event)?.(error) }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 5))

describe('installCrashHandlers', () => {
	it('Writes a terminal status for SIGTERM and an unhandled rejection', async () => {
		const reasons: string[] = []
		const { target, fire } = fakeTarget()
		installCrashHandlers(target, { fail: async reason => void reasons.push(reason), exit: () => {} })

		fire('SIGTERM')
		fire('unhandledRejection', new Error('db down'))
		await settle()

		expect(reasons[0]).toBe('SIGTERM received')
		expect(reasons[1]).toMatch(/^unhandled: Error: db down/)
	})

	// ORC-04: there was no `uncaughtException` handler anywhere in the repo, so a throw from a
	// stream listener (a `RangeError` from an oversized captured output) printed and exited with
	// no status write at all — the row stayed mid-build until the api's liveness sweep.
	it('Writes a terminal status for an uncaught exception and exits non-zero', async () => {
		const reasons: string[] = []
		const codes: number[] = []
		const { target, fire } = fakeTarget()
		installCrashHandlers(target, {
			fail: async reason => void reasons.push(reason),
			exit: code => void codes.push(code),
		})

		fire('uncaughtException', new RangeError('Invalid string length'))
		await settle()

		expect(reasons).toHaveLength(1)
		expect(reasons[0]).toMatch(/^uncaught: RangeError: Invalid string length/)
		expect(codes).toEqual([1])
	})

	it('Exits anyway when the terminal write does not finish within the deadline', async () => {
		const codes: number[] = []
		const { target, fire } = fakeTarget()
		installCrashHandlers(target, {
			// A process in an undefined state can hang on the network write; the handler must not
			fail: () => new Promise<void>(() => {}),
			deadlineMs: 1,
			exit: code => void codes.push(code),
		})

		fire('uncaughtException', new Error('boom'))
		await settle()

		expect(codes).toEqual([1])
	})

	it('Exits when the terminal write itself rejects', async () => {
		const codes: number[] = []
		const { target, fire } = fakeTarget()
		installCrashHandlers(target, {
			fail: async () => {
				throw new Error('reporter unreachable')
			},
			exit: code => void codes.push(code),
		})

		fire('uncaughtException', 'not an Error')
		await settle()

		expect(codes).toEqual([1])
	})
})

/**
 * Process-level crash handlers for the build-job container. Every path that ends the process
 * abnormally must still leave a terminal status on the job row — a container that dies quietly
 * leaves the row `building`/`verifying` until the api's liveness sweep notices the STOPPED task
 * minutes later, after the whole budget has been spent.
 */

export type CrashEvent = 'SIGTERM' | 'unhandledRejection' | 'uncaughtException'

/** What a handler needs from the process it is installed on (a real `process` satisfies it) */
export type CrashTarget = {
	on: (event: CrashEvent, listener: (error: unknown) => void) => unknown
}

export type CrashHandlerOptions = {
	/** Writes the terminal status; the real one ends in `process.exit(1)` */
	fail: (reason: string) => Promise<void>
	/** Cap on how long the terminal write may take after an uncaught exception */
	deadlineMs?: number
	/** Called when `fail` did not exit within the deadline (default: `process.exit`) */
	exit?: (code: number) => void
}

const reasonOf = (error: unknown) =>
	error instanceof Error ? (error.stack ?? error.message) : String(error)

/**
 * `SIGTERM` and `unhandledRejection` simply run `fail`, which writes the row and exits.
 *
 * `uncaughtException` is the one that used to be missing entirely (audit ORC-04): nothing handled
 * it, so Node printed the error and exited, `fail()` never ran, and the row was left mid-build.
 * Anything a stream/event listener throws lands here — a `RangeError: Invalid string length` from
 * an oversized captured output is the realistic case — and by then the process state is
 * undefined, so awaiting a network write unconditionally could itself hang. The write therefore
 * gets a deadline and the process exits either way.
 */
export const installCrashHandlers = (
	target: CrashTarget,
	{ fail, deadlineMs = 10_000, exit = code => process.exit(code) }: CrashHandlerOptions
) => {
	target.on('SIGTERM', () => void fail('SIGTERM received'))
	target.on('unhandledRejection', error => void fail(`unhandled: ${reasonOf(error)}`))
	target.on('uncaughtException', error => {
		const deadline = new Promise<void>(resolve => {
			setTimeout(resolve, deadlineMs).unref?.()
		})
		void Promise.race([fail(`uncaught: ${reasonOf(error)}`), deadline]).then(
			() => exit(1),
			() => exit(1)
		)
	})
}

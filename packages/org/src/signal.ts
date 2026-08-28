/** Abort + sleep helpers for the pollers, mirroring the delivery clients in @mf/harness. */

/** The error a poll/sleep rejects with when its signal aborts. */
export const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' })

/** Resolves after `ms`, or rejects at once when `signal` aborts (so a poll stops immediately). */
export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
	new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(abortError())
		const onAbort = () => {
			clearTimeout(timer)
			reject(abortError())
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort)
			resolve()
		}, ms)
		signal?.addEventListener('abort', onAbort, { once: true })
	})

/** A pluggable sleep, so tests can resolve instantly (or abort) without real timers. */
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>

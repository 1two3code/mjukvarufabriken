/** Shared abort + sleep helpers for the delivery clients that poll AWS (image build, Express deploy) */

export const abortError = () => new Error('aborted')

/** Resolves after `ms`, or rejects at once when `signal` aborts (so polling stops immediately) */
export const defaultSleep = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve, reject) => {
		if (signal?.aborted) return reject(abortError())
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort)
			resolve()
		}, ms)
		const onAbort = () => {
			clearTimeout(timer)
			reject(abortError())
		}
		signal?.addEventListener('abort', onAbort, { once: true })
	})

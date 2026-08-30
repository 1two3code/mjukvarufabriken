/**
 * Checks if a value is a function.
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
export function isFunction(value: unknown): value is Function {
	return typeof value === 'function'
}

/**
 * Returns the resolved value from a promise if it resolves, or the rejected value as an error if it rejects.
 */
export async function tryCatch<T, E = Error>(promise: Promise<T>): Promise<[null, T] | [E, null]> {
	try {
		const result = await promise
		return [null, result]
	} catch (error) {
		return [error as E, null]
	}
}

/**
 * Returns the result of a function if it runs successfully, or an error if it throws.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function tryCatchSync<T extends (...args: any[]) => any, E = Error>(
	func: T,
	...args: Parameters<T>
): [null, ReturnType<T>] | [E, null] {
	try {
		const result = func(...args)
		return [null, result]
	} catch (error) {
		return [error as E, null]
	}
}

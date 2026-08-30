import type { Exact, PartialDeep, UnknownRecord } from 'type-fest'

/**
 * Checks if the given value is a plain object (not an array, not null).
 */
export function isObject(value: unknown): value is UnknownRecord {
	return value === Object(value) && Object.prototype.toString.call(value) !== '[object Array]'
}

/**
 * Remove all (shallow) properties from an object that are undefined.
 */
export function removeUndefinedProperties<T extends UnknownRecord>(object: T): Partial<T> {
	return Object.keys(object).reduce(
		(acc, key) => (object[key] === undefined ? acc : { ...acc, [key]: object[key] }),
		{}
	)
}

/**
 * Deep merge an object with nested overrides. Neither argument is mutated.
 */
export function mergeDeep<T extends UnknownRecord, O extends Exact<PartialDeep<T>, O>>(
	defaultObject: T,
	overrides?: O
): T {
	if (!overrides) return structuredClone(defaultObject)

	const mergeInto = (target: UnknownRecord, patch: UnknownRecord) => {
		Object.keys(patch).forEach(key => {
			const patchVal = patch[key]
			const targetVal = target[key]

			if (isObject(targetVal) && isObject(patchVal)) return mergeInto(targetVal, patchVal)

			target[key] =
				isObject(patchVal) || Array.isArray(patchVal) ? structuredClone(patchVal) : patchVal
		})
	}

	const result = structuredClone(defaultObject)
	mergeInto(result, overrides)
	return result
}

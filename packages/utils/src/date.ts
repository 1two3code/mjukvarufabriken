export type TimeUnit = 'second' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year'

/**
 * Checks if a Date instance has a valid date.
 */
export function isValidDate(date: Date): boolean {
	return date instanceof Date && !Number.isNaN(date.getTime())
}

/**
 * Converts a date string to a UTC ISO string.
 */
export function toUtc(date: string): string {
	const parsed = new Date(date)
	if (!isValidDate(parsed)) throw new Error('Invalid date')
	return parsed.toISOString()
}

/**
 * Returns a new Date instance with the specified time added to the given date.
 */
export function addTime(date: Date, value: number | string, unit: TimeUnit): Date {
	const length = Number(value)
	const newDate = new Date(date)
	switch (unit) {
		case 'year':
			return new Date(newDate.setFullYear(newDate.getFullYear() + length))
		case 'month':
			return new Date(newDate.setMonth(newDate.getMonth() + length))
		case 'week':
			return new Date(newDate.setDate(newDate.getDate() + length * 7))
		case 'day':
			return new Date(newDate.setDate(newDate.getDate() + length))
		case 'hour':
			return new Date(newDate.setHours(newDate.getHours() + length))
		case 'minute':
			return new Date(newDate.setMinutes(newDate.getMinutes() + length))
		case 'second':
			return new Date(newDate.setSeconds(newDate.getSeconds() + length))
	}
}

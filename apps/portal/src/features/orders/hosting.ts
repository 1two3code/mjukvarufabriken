import type { LifecycleState } from '@mf/models'

const dayMs = 24 * 60 * 60 * 1000

/** What the hosting panel says about an order's included hosting window (wave 14) */
export type HostingWindowState =
	/** No scheduled end (not delivered yet, or an admin cleared it) */
	| { kind: 'none' }
	/** Hosted until `until`; `daysLeft` is whole days, rounded up, never below 0 */
	| { kind: 'open'; until: Date; daysLeft: number }
	/** The window ended but the scheduled teardown has not run yet (within the hour) */
	| { kind: 'ended'; until: Date }
	/** Everything the hosting held is gone; only the export remains */
	| { kind: 'tornDown'; until?: Date }

export const hostingWindowState = (
	hostingUntil: string | undefined,
	lifecycle: LifecycleState,
	now = new Date()
): HostingWindowState => {
	const until = hostingUntil === undefined ? undefined : new Date(hostingUntil)
	if (lifecycle === 'torn_down') return { kind: 'tornDown', until }
	if (!until) return { kind: 'none' }
	if (until.getTime() <= now.getTime()) return { kind: 'ended', until }
	return { kind: 'open', until, daysLeft: Math.ceil((until.getTime() - now.getTime()) / dayMs) }
}

/** `YYYY-MM-DD` of the instant, for a native date input (local calendar day) */
export const toDateInputValue = (date: Date | undefined) => {
	if (!date) return ''
	const pad = (value: number) => String(value).padStart(2, '0')
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * A date input's `YYYY-MM-DD` as the instant the window ends: the END of that local day, so an
 * admin who picks "the 24th" keeps the app up through the 24th. Undefined for an empty / malformed value.
 */
export const fromDateInputValue = (value: string): string | undefined => {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
	if (!match) return undefined
	const [, year, month, day] = match
	const end = new Date(Number(year), Number(month) - 1, Number(day), 23, 59, 59, 999)
	// `new Date` rolls an impossible month/day over into the next one; refuse anything that moved
	const faithful = end.getMonth() === Number(month) - 1 && end.getDate() === Number(day)
	return faithful ? end.toISOString() : undefined
}

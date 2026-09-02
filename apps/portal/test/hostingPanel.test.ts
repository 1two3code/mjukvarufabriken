import {
	fromDateInputValue,
	hostingWindowState,
	toDateInputValue,
} from '#/features/orders/hosting.ts'

const now = new Date('2026-09-02T12:00:00.000Z')

describe('Hosting window on the order page (wave 14)', () => {
	it('Has no scheduled end without a window', () => {
		expect(hostingWindowState(undefined, 'active', now)).toEqual({ kind: 'none' })
	})

	it('Counts whole days left, rounded up, while the window is open', () => {
		const state = hostingWindowState('2026-09-04T18:00:00.000Z', 'active', now)
		expect(state).toMatchObject({ kind: 'open', daysLeft: 3 })
		// A window ending within the hour is still "1 day left", never "0 days"
		expect(hostingWindowState('2026-09-02T12:30:00.000Z', 'active', now)).toMatchObject({
			kind: 'open',
			daysLeft: 1,
		})
	})

	it('Reports an ended window until the teardown runs, then torn down', () => {
		expect(hostingWindowState('2026-09-01T00:00:00.000Z', 'active', now)).toMatchObject({
			kind: 'ended',
		})
		expect(hostingWindowState('2026-09-01T00:00:00.000Z', 'torn_down', now)).toMatchObject({
			kind: 'tornDown',
		})
		// Torn down by an admin without a window at all
		expect(hostingWindowState(undefined, 'torn_down', now)).toEqual({
			kind: 'tornDown',
			until: undefined,
		})
	})

	it('Round-trips the admin date input as the end of that day', () => {
		const iso = fromDateInputValue('2026-12-24')
		expect(iso).toBeDefined()
		const end = new Date(iso!)
		expect(end.getFullYear()).toBe(2026)
		expect(end.getMonth()).toBe(11)
		expect(end.getDate()).toBe(24)
		expect(end.getHours()).toBe(23)
		expect(toDateInputValue(end)).toBe('2026-12-24')
		expect(toDateInputValue(undefined)).toBe('')
		expect(fromDateInputValue('')).toBeUndefined()
		expect(fromDateInputValue('2026-13-45')).toBeUndefined()
	})
})

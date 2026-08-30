import { monthOf } from '#/metering.ts'

import type { ObjectStore } from '#/store.ts'

export const monthKey = (month: string) => `months/${month}.json`

type MonthState = { month: string; usedTokens: number }

export type MonthlyCapOptions = {
	store: ObjectStore
	/** `RESIDENT_MONTHLY_TOKENS` — budget-weighted tokens per calendar month (UTC) */
	maxTokens: number
	now?: () => number
}

/**
 * Hard monthly token cap. The counter is the month object in the store (persisted on every
 * `add`, so a restart or a new task never forgets what the month has spent) and a task is only
 * started with a budget of `remaining()`; the harness aborts the task the moment that budget is
 * crossed, so the cap can be overshot by at most one in-flight model turn. A new month resets.
 */
export const createMonthlyCap = ({ store, maxTokens, now = Date.now }: MonthlyCapOptions) => {
	let state: MonthState | undefined

	const load = async (): Promise<MonthState> => {
		const month = monthOf(now())
		if (state?.month === month) return state
		const stored = await store.get(monthKey(month))
		state = stored ? (JSON.parse(stored) as MonthState) : { month, usedTokens: 0 }
		return state
	}

	const persist = async (current: MonthState) =>
		store.put(monthKey(current.month), JSON.stringify(current))

	return {
		maxTokens,
		month: async () => (await load()).month,
		used: async () => (await load()).usedTokens,
		remaining: async () => Math.max(0, maxTokens - (await load()).usedTokens),
		reached: async () => (await load()).usedTokens >= maxTokens,
		/** Count tokens against the current month and persist; returns true when the cap is now reached */
		add: async (tokens: number) => {
			const current = await load()
			current.usedTokens += Math.max(0, Math.round(tokens))
			await persist(current)
			return current.usedTokens >= maxTokens
		},
	}
}

export type MonthlyCap = ReturnType<typeof createMonthlyCap>

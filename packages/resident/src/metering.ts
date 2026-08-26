import { totalTokens } from '@mf/harness'
import { residentUsageMarkup } from '@mf/models'

import { listPriceUsd, roundUsd } from '#/pricing.ts'

import type { TokenUsage } from '@mf/harness'
import type { ResidentModelUsage, ResidentTaskCounts, ResidentUsageRecord } from '@mf/models'
import type { ModelPrice } from '#/pricing.ts'
import type { ObjectStore } from '#/store.ts'

// MARK: Time keys

export const dayOf = (time: number | string | Date) => new Date(time).toISOString().slice(0, 10)
export const monthOf = (time: number | string | Date) => new Date(time).toISOString().slice(0, 7)

export const usageKey = (day: string) => `usage/${day}.json`

// MARK: Pure math

export const emptyModelUsage = (): ResidentModelUsage => ({
	inputTokens: 0,
	outputTokens: 0,
	cacheReadInputTokens: 0,
	cacheCreationInputTokens: 0,
	budgetTokens: 0,
})

export const emptyTaskCounts = (): ResidentTaskCounts => ({
	started: 0,
	succeeded: 0,
	failed: 0,
	pullRequestsOpened: 0,
})

/** Adds one usage report to a model's buckets (`budgetTokens` weighted like the job budget) */
export const addUsage = (current: ResidentModelUsage, usage: TokenUsage): ResidentModelUsage => ({
	inputTokens: current.inputTokens + usage.inputTokens,
	outputTokens: current.outputTokens + usage.outputTokens,
	cacheReadInputTokens: current.cacheReadInputTokens + (usage.cacheReadInputTokens ?? 0),
	cacheCreationInputTokens:
		current.cacheCreationInputTokens + (usage.cacheCreationInputTokens ?? 0),
	budgetTokens: current.budgetTokens + totalTokens(usage),
})

export type DayUsage = {
	tokensByModel: Record<string, ResidentModelUsage>
	tasks: ResidentTaskCounts
}

export const emptyDayUsage = (): DayUsage => ({ tokensByModel: {}, tasks: emptyTaskCounts() })

export const totalBudgetTokens = (tokensByModel: Record<string, ResidentModelUsage>) =>
	Object.values(tokensByModel).reduce((sum, usage) => sum + usage.budgetTokens, 0)

/** Anthropic list price of a day, summed over models */
export const dayListPriceUsd = (
	tokensByModel: Record<string, ResidentModelUsage>,
	prices?: Record<string, ModelPrice>
) =>
	roundUsd(
		Object.entries(tokensByModel).reduce(
			(sum, [model, usage]) => sum + listPriceUsd(model, usage, prices),
			0
		)
	)

export type UsageRecordInput = {
	installationId: string
	repository: string
	day: string
	usage: DayUsage
	monthlyCap: { tokens: number; usedTokens: number }
	prices?: Record<string, ModelPrice>
	markup?: number
	now?: () => number
}

/** The record that goes to S3 and the factory api: list price × markup, tokens by model, task counts */
export const buildUsageRecord = ({
	installationId,
	repository,
	day,
	usage,
	monthlyCap,
	prices,
	markup = residentUsageMarkup,
	now = Date.now,
}: UsageRecordInput): ResidentUsageRecord => {
	const listPrice = dayListPriceUsd(usage.tokensByModel, prices)
	return {
		installationId,
		repository,
		day,
		month: day.slice(0, 7),
		tokensByModel: usage.tokensByModel,
		totalTokens: totalBudgetTokens(usage.tokensByModel),
		tasks: usage.tasks,
		cost: { listPriceUsd: listPrice, markup, billableUsd: roundUsd(listPrice * markup) },
		monthlyCap,
		generatedAt: new Date(now()).toISOString(),
	}
}

// MARK: Meter

export type UsageMeterOptions = {
	store: ObjectStore
	now?: () => number
}

/**
 * Accumulates the current day's tokens by model and task counts in memory, persisting the day
 * object on every `flush`. On start-up the day so far is reloaded from the store, so a restart
 * mid-day does not lose what was already flushed. The month counter for the cap lives in
 * `MonthlyCap`, not here.
 */
export const createUsageMeter = ({ store, now = Date.now }: UsageMeterOptions) => {
	// The promise is cached, not the value: concurrent first reports of a day must share one object
	const days = new Map<string, Promise<DayUsage>>()

	const load = (day: string): Promise<DayUsage> => {
		const cached = days.get(day)
		if (cached) return cached
		const loading = store
			.get(usageKey(day))
			.then(stored =>
				stored ? dayUsageFromRecord(JSON.parse(stored) as ResidentUsageRecord) : emptyDayUsage()
			)
		days.set(day, loading)
		return loading
	}

	return {
		/** Record one model call's usage on today's counters */
		addTokens: async (model: string, usage: TokenUsage, time = now()) => {
			const day = await load(dayOf(time))
			day.tokensByModel[model] = addUsage(day.tokensByModel[model] ?? emptyModelUsage(), usage)
		},
		count: async (what: keyof ResidentTaskCounts, time = now()) => {
			const day = await load(dayOf(time))
			day.tasks[what] += 1
		},
		/** The day's counters (a copy) */
		read: async (day: string): Promise<DayUsage> => structuredClone(await load(day)),
		/** Days with unsaved changes since the process started (today, plus yesterday around midnight) */
		days: () => [...days.keys()],
		/** Drop days that are older than the two most recent, once persisted */
		forget: (day: string) => days.delete(day),
	}
}

export type UsageMeter = ReturnType<typeof createUsageMeter>

const dayUsageFromRecord = (record: ResidentUsageRecord): DayUsage => ({
	tokensByModel: record.tokensByModel,
	tasks: record.tasks,
})

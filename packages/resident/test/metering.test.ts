import { residentUsageMarkup, ResidentUsageRecordSchema } from '@mf/models'

import {
	addUsage,
	buildUsageRecord,
	createUsageMeter,
	dayListPriceUsd,
	dayOf,
	emptyModelUsage,
	monthOf,
	usageKey,
} from '#/metering.ts'
import { listPriceUsd, parsePriceOverrides, priceOf } from '#/pricing.ts'
import { createMemoryObjectStore } from '#/store.ts'

const noon = Date.parse('2026-09-03T12:00:00.000Z')

describe('pricing', () => {
	it('Picks the longest matching model prefix and falls back to the Sonnet tier', () => {
		expect(priceOf('claude-opus-4-1-20250805')).toEqual({
			input: 15,
			output: 75,
			cacheRead: 1.5,
			cacheWrite: 18.75,
		})
		expect(priceOf('claude-3-5-haiku-20241022').input).toBe(0.8)
		expect(priceOf('claude-haiku-4-5').input).toBe(1)
		expect(priceOf('some-new-model')).toEqual(priceOf('claude-sonnet-5'))
	})

	it('Prices every bucket at its own rate per million tokens', () => {
		const usd = listPriceUsd('claude-sonnet-5', {
			inputTokens: 1_000_000,
			outputTokens: 100_000,
			cacheReadInputTokens: 2_000_000,
			cacheCreationInputTokens: 400_000,
		})
		// 3 + 1.5 + 0.6 + 1.5
		expect(usd).toBeCloseTo(6.6, 6)
	})

	it('Parses price overrides and derives cache prices from the input price', () => {
		const prices = parsePriceOverrides('{"claude-sonnet": {"input": 4, "output": 20}}')
		expect(prices).toEqual({
			'claude-sonnet': { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
		})
		expect(parsePriceOverrides(undefined)).toEqual({})
		expect(priceOf('claude-sonnet-5', prices).output).toBe(20)
	})
})

describe('metering math', () => {
	it('Keys days and months in UTC', () => {
		expect(dayOf(noon)).toBe('2026-09-03')
		expect(monthOf(noon)).toBe('2026-09')
		expect(dayOf('2026-09-30T23:59:59.000Z')).toBe('2026-09-30')
	})

	it('Accumulates every bucket and weights cache reads at 10 % for the cap', () => {
		const usage = addUsage(emptyModelUsage(), {
			inputTokens: 100,
			outputTokens: 50,
			cacheReadInputTokens: 1000,
			cacheCreationInputTokens: 20,
		})
		expect(usage).toEqual({
			inputTokens: 100,
			outputTokens: 50,
			cacheReadInputTokens: 1000,
			cacheCreationInputTokens: 20,
			budgetTokens: 270,
		})
	})

	it('Builds a record with list price × 1.5 and the total over models', () => {
		const tokensByModel = {
			'claude-sonnet-5': { ...emptyModelUsage(), inputTokens: 1_000_000, budgetTokens: 1_000_000 },
			'claude-opus-4-1': { ...emptyModelUsage(), outputTokens: 100_000, budgetTokens: 100_000 },
		}
		expect(dayListPriceUsd(tokensByModel)).toBe(10.5)

		const record = buildUsageRecord({
			installationId: 'acme',
			repository: 'acme/shop',
			day: '2026-09-03',
			usage: {
				tokensByModel,
				tasks: { started: 2, succeeded: 1, failed: 1, pullRequestsOpened: 1 },
			},
			monthlyCap: { tokens: 50_000_000, usedTokens: 1_100_000 },
			now: () => noon,
		})

		expect(ResidentUsageRecordSchema.parse(record)).toEqual(record)
		expect(record).toMatchObject({
			month: '2026-09',
			totalTokens: 1_100_000,
			cost: { listPriceUsd: 10.5, markup: residentUsageMarkup, billableUsd: 15.75 },
			generatedAt: '2026-09-03T12:00:00.000Z',
		})
	})
})

describe('usage meter', () => {
	it('Counts tokens by model and tasks per day, and reloads a stored day', async () => {
		// Arrange
		const store = createMemoryObjectStore()
		const meter = createUsageMeter({ store, now: () => noon })

		// Act
		await meter.addTokens('claude-sonnet-5', { inputTokens: 10, outputTokens: 5 })
		await meter.addTokens('claude-sonnet-5', { inputTokens: 10, outputTokens: 0 })
		await meter.addTokens('claude-opus-4-1', { inputTokens: 1, outputTokens: 1 })
		await meter.count('started')
		await meter.count('succeeded')
		const day = await meter.read('2026-09-03')

		// Assert
		expect(day.tokensByModel['claude-sonnet-5']).toMatchObject({
			inputTokens: 20,
			outputTokens: 5,
			budgetTokens: 25,
		})
		expect(day.tasks).toEqual({ started: 1, succeeded: 1, failed: 0, pullRequestsOpened: 0 })
		expect(meter.days()).toEqual(['2026-09-03'])

		// A restart picks up the persisted record for the day
		const record = buildUsageRecord({
			installationId: 'acme',
			repository: 'acme/shop',
			day: '2026-09-03',
			usage: day,
			monthlyCap: { tokens: 1, usedTokens: 0 },
		})
		await store.put(usageKey('2026-09-03'), JSON.stringify(record))
		const restarted = createUsageMeter({ store, now: () => noon })
		await restarted.addTokens('claude-opus-4-1', { inputTokens: 1, outputTokens: 0 })
		expect(
			(await restarted.read('2026-09-03')).tokensByModel['claude-opus-4-1']?.budgetTokens
		).toBe(3)
	})

	it('Forgets a day whose read failed, so the next report loads it again', async () => {
		// Arrange: the first touch of the day hits an S3 outage
		const store = createMemoryObjectStore()
		const meter = createUsageMeter({ store, now: () => noon })
		store.failing = 'get'

		// Act
		await expect(meter.count('started')).rejects.toThrow('get usage/2026-09-03.json failed')
		store.failing = undefined
		await meter.count('started')

		// Assert: the day is counted, not poisoned by the cached rejection
		expect((await meter.read('2026-09-03')).tasks.started).toBe(1)
		expect(meter.days()).toEqual(['2026-09-03'])
	})
})

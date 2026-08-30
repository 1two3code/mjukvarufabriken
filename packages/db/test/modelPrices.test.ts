import { pricesEffectiveAt } from '@mf/models'

import { createMemoryRepositories } from '#/memory.ts'
import { defaultModelPriceRows, toModelPriceRow } from '#/modelPrices.ts'

describe('model prices repository', () => {
	it('Maps numeric strings from the driver to numbers', () => {
		expect(
			toModelPriceRow({
				id: 'p1',
				model_prefix: 'claude-sonnet',
				input: '3.0000',
				output: '15.0000',
				cache_read: '0.3000',
				cache_write: '3.7500',
				effective_from: new Date('2026-08-28T00:00:00Z'),
				created_at: new Date('2026-08-28T00:00:00Z'),
			})
		).toEqual({
			id: 'p1',
			modelPrefix: 'claude-sonnet',
			input: 3,
			output: 15,
			cacheRead: 0.3,
			cacheWrite: 3.75,
			effectiveFrom: '2026-08-28T00:00:00.000Z',
			createdAt: '2026-08-28T00:00:00.000Z',
		})
	})

	it('Memory backend starts from the seed prices and a new row only affects later instants', async () => {
		const { modelPrices } = createMemoryRepositories()
		const seeded = await modelPrices.list()
		expect(seeded).toHaveLength(defaultModelPriceRows().length)

		const before = new Date('2026-09-01T00:00:00Z')
		const after = new Date('2026-09-02T00:00:00Z')
		expect((await modelPrices.effectiveAt(before))['claude-sonnet']?.input).toBe(3)

		await modelPrices.insert({
			modelPrefix: 'claude-sonnet',
			input: 2,
			output: 10,
			cacheRead: 0.2,
			cacheWrite: 2.5,
			effectiveFrom: '2026-09-01T12:00:00Z',
		})
		expect((await modelPrices.effectiveAt(before))['claude-sonnet']?.input).toBe(3)
		expect((await modelPrices.effectiveAt(after))['claude-sonnet']?.input).toBe(2)
		// Newest first
		expect((await modelPrices.list())[0]?.input).toBe(2)
	})

	it('Rejects an exact duplicate (prefix + effectiveFrom) like the unique constraint', async () => {
		const { modelPrices } = createMemoryRepositories()
		const row = { modelPrefix: 'x', input: 1, output: 1, cacheRead: 1, cacheWrite: 1, effectiveFrom: '2026-09-01T00:00:00Z' }
		await modelPrices.insert(row)
		await expect(modelPrices.insert(row)).rejects.toMatchObject({ code: '23505' })
	})

	it('pricesEffectiveAt ignores rows dated after the instant', () => {
		const rows = defaultModelPriceRows()
		expect(pricesEffectiveAt(rows, new Date('2026-01-01T00:00:00Z'))).toEqual({})
		expect(Object.keys(pricesEffectiveAt(rows, new Date('2026-08-28T00:00:00Z')))).toHaveLength(4)
	})
})

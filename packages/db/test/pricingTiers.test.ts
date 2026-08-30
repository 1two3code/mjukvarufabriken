import { createMemoryRepositories } from '#/memory.ts'
import { toPricingTierRow } from '#/pricingTiers.ts'

describe('pricing tiers repository', () => {
	it('Maps a numeric price string from the driver to a number', () => {
		expect(
			toPricingTierRow({
				id: 't1',
				tier_key: 'starter',
				name: 'Starter',
				price: '299.00',
				currency: 'SEK',
				description: 'A small demo build',
				effective_from: new Date('2026-09-01T00:00:00Z'),
				created_at: new Date('2026-09-01T00:00:00Z'),
			})
		).toEqual({
			id: 't1',
			tierKey: 'starter',
			name: 'Starter',
			price: 299,
			currency: 'SEK',
			description: 'A small demo build',
			effectiveFrom: '2026-09-01T00:00:00.000Z',
			createdAt: '2026-09-01T00:00:00.000Z',
		})
	})

	it('Memory backend starts empty — unlike model_prices, there is no built-in seed', async () => {
		const { pricingTiers } = createMemoryRepositories()
		expect(await pricingTiers.list()).toEqual([])
	})

	it('Inserts a row (effectiveFrom defaults to now) and lists newest first', async () => {
		const { pricingTiers } = createMemoryRepositories()
		await pricingTiers.insert({
			tierKey: 'starter',
			name: 'Starter',
			price: 299,
			currency: 'SEK',
			description: 'A small demo build',
			effectiveFrom: '2026-09-01T00:00:00Z',
		})
		await pricingTiers.insert({
			tierKey: 'starter',
			name: 'Starter (revised)',
			price: 349,
			currency: 'SEK',
			description: 'A small demo build, revised',
			effectiveFrom: '2026-09-02T00:00:00Z',
		})

		const rows = await pricingTiers.list()
		expect(rows).toHaveLength(2)
		expect(rows[0]).toMatchObject({ name: 'Starter (revised)', price: 349 })
		expect(rows[1]).toMatchObject({ name: 'Starter', price: 299 })
	})

	it('Rejects an exact duplicate (tierKey + effectiveFrom) like the unique constraint', async () => {
		const { pricingTiers } = createMemoryRepositories()
		const row = {
			tierKey: 'free',
			name: 'Free',
			price: 0,
			currency: 'SEK',
			description: '',
			effectiveFrom: '2026-09-01T00:00:00Z',
		}
		await pricingTiers.insert(row)
		await expect(pricingTiers.insert(row)).rejects.toMatchObject({ code: '23505' })
	})
})

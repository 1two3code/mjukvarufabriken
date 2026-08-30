import type { NewPricingTier, PricingTierRow } from '@mf/models'
import type { Db } from './index.ts'
import type { PricingTiersRepository } from './repositories.ts'

// MARK: Row mapping

type PricingTierRowDb = {
	id: string
	tier_key: string
	name: string
	/** `numeric` columns arrive as strings from the driver */
	price: string | number
	currency: string
	description: string
	effective_from: Date
	created_at: Date
}

export const toPricingTierRow = (row: PricingTierRowDb): PricingTierRow => ({
	id: row.id,
	tierKey: row.tier_key,
	name: row.name,
	price: Number(row.price),
	currency: row.currency,
	description: row.description,
	effectiveFrom: row.effective_from.toISOString(),
	createdAt: row.created_at.toISOString(),
})

// MARK: Queries

/** Every row, newest `effective_from` first (then key) — the admin's full history */
export const listPricingTiers = async (db: Db): Promise<PricingTierRow[]> => {
	const rows = await db.sql<PricingTierRowDb[]>`
		select * from pricing_tiers order by effective_from desc, tier_key asc`
	return rows.map(toPricingTierRow)
}

export const insertPricingTier = async (db: Db, tier: NewPricingTier): Promise<PricingTierRow> => {
	const [row] = await db.sql<PricingTierRowDb[]>`
		insert into pricing_tiers (tier_key, name, price, currency, description, effective_from)
		values (
			${tier.tierKey}, ${tier.name}, ${tier.price}, ${tier.currency}, ${tier.description},
			${tier.effectiveFrom ? new Date(tier.effectiveFrom) : new Date()}
		)
		returning *`
	return toPricingTierRow(row!)
}

export const createPricingTiersRepository = (db: Db): PricingTiersRepository => ({
	list: () => listPricingTiers(db),
	insert: tier => insertPricingTier(db, tier),
})

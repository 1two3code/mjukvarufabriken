import { defaultModelPrices, pricesEffectiveAt } from '@mf/models'

import type { ModelPriceRow, ModelPrices, NewModelPrice } from '@mf/models'
import type { Db } from './index.ts'
import type { ModelPricesRepository } from './repositories.ts'

// MARK: Row mapping

type ModelPriceRowDb = {
	id: string
	model_prefix: string
	/** `numeric` columns arrive as strings from the driver */
	input: string | number
	output: string | number
	cache_read: string | number
	cache_write: string | number
	effective_from: Date
	created_at: Date
}

export const toModelPriceRow = (row: ModelPriceRowDb): ModelPriceRow => ({
	id: row.id,
	modelPrefix: row.model_prefix,
	input: Number(row.input),
	output: Number(row.output),
	cacheRead: Number(row.cache_read),
	cacheWrite: Number(row.cache_write),
	effectiveFrom: row.effective_from.toISOString(),
	createdAt: row.created_at.toISOString(),
})

/**
 * The built-in list prices as rows, all effective from the capture date — what the memory
 * backend starts from (the Postgres table is seeded by migration 0018 with the same figures).
 */
export const defaultModelPriceRows = (): ModelPriceRow[] =>
	Object.entries(defaultModelPrices).map(([modelPrefix, price], index) => ({
		id: `default-${index + 1}`,
		modelPrefix,
		...price,
		effectiveFrom: '2026-08-28T00:00:00.000Z',
		createdAt: '2026-08-28T00:00:00.000Z',
	}))

// MARK: Queries

/** Every row, newest `effective_from` first (then prefix) */
export const listModelPrices = async (db: Db): Promise<ModelPriceRow[]> => {
	const rows = await db.sql<ModelPriceRowDb[]>`
		select * from model_prices order by effective_from desc, model_prefix asc`
	return rows.map(toModelPriceRow)
}

export const insertModelPrice = async (db: Db, price: NewModelPrice): Promise<ModelPriceRow> => {
	const [row] = await db.sql<ModelPriceRowDb[]>`
		insert into model_prices (model_prefix, input, output, cache_read, cache_write, effective_from)
		values (
			${price.modelPrefix}, ${price.input}, ${price.output}, ${price.cacheRead}, ${price.cacheWrite},
			${price.effectiveFrom ? new Date(price.effectiveFrom) : new Date()}
		)
		returning *`
	return toModelPriceRow(row!)
}

/** The prices in effect at `at` (see `pricesEffectiveAt`); the seed rows when the table is empty */
export const modelPricesEffectiveAt = async (db: Db, at: Date): Promise<ModelPrices> => {
	const rows = await listModelPrices(db)
	return rows.length ? pricesEffectiveAt(rows, at) : defaultModelPrices
}

export const createModelPricesRepository = (db: Db): ModelPricesRepository => ({
	list: () => listModelPrices(db),
	insert: price => insertModelPrice(db, price),
	effectiveAt: at => modelPricesEffectiveAt(db, at),
})

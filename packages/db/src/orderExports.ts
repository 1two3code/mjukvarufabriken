import { isUuid } from './jobs.ts'

import type { OrderExport, OrderExportFile, OrderExportStatus } from '@mf/models'
import type { Db } from './index.ts'
import type { ExportClaim, ExportFinish, OrderExportsRepository } from './repositories.ts'

// MARK: Row mapping

type OrderExportRow = {
	order_id: string
	job_id: string | null
	key: string
	status: OrderExportStatus
	files: OrderExportFile[]
	error: string | null
	created_at: Date
	finished_at: Date | null
}

export const toOrderExport = (row: OrderExportRow): OrderExport => ({
	orderId: row.order_id,
	jobId: row.job_id ?? undefined,
	key: row.key,
	status: row.status,
	files: row.files,
	error: row.error ?? undefined,
	createdAt: row.created_at.toISOString(),
	finishedAt: row.finished_at?.toISOString(),
})

// MARK: Queries

export const getOrderExport = async (db: Db, orderId: string): Promise<OrderExport | undefined> => {
	const [row] = await db.sql<OrderExportRow[]>`
		select * from order_exports where order_id = ${orderId}`
	return row && toOrderExport(row)
}

/**
 * Insert-or-reclaim compare-and-set. The upsert's `where` is the whole lock: a fresh row is
 * inserted `pending`; an existing `failed` row, a `pending` one older than `staleBefore` or (only
 * when `doneBefore` is given) a `done` one finished before it is re-claimed (reset to `pending`,
 * files cleared); anything else matches nothing, so `returning` is empty and the caller reads the
 * row it lost to. `finished_at < null` is null, i.e. false — a `done` row is final by default.
 */
export const claimOrderExport = async (
	db: Db,
	claim: ExportClaim,
	staleBefore: Date,
	doneBefore?: Date
): Promise<{ export: OrderExport; claimed: boolean }> => {
	const { sql } = db
	const jobId = claim.jobId && isUuid(claim.jobId) ? claim.jobId : null
	const [row] = await sql<OrderExportRow[]>`
		insert into order_exports (order_id, job_id, key)
		values (${claim.orderId}, ${jobId}, ${claim.key})
		on conflict (order_id) do update set
			job_id = excluded.job_id,
			key = excluded.key,
			status = 'pending',
			files = '[]'::jsonb,
			error = null,
			created_at = now(),
			finished_at = null
		where order_exports.status = 'failed'
			or (order_exports.status = 'pending' and order_exports.created_at < ${staleBefore})
			or (order_exports.status = 'done' and order_exports.finished_at < ${doneBefore ?? null})
		returning *`
	if (row) return { export: toOrderExport(row), claimed: true }
	const existing = await getOrderExport(db, claim.orderId)
	// The row cannot vanish between the two statements (nothing deletes exports); belt and braces
	if (!existing) throw new Error(`order_exports: lost the row for order ${claim.orderId}`)
	return { export: existing, claimed: false }
}

/** Finishes the pending claim; `undefined` when the row is missing or no longer pending */
export const finishOrderExport = async (
	db: Db,
	orderId: string,
	finish: ExportFinish
): Promise<OrderExport | undefined> => {
	const { sql } = db
	const [row] = await sql<OrderExportRow[]>`
		update order_exports set
			status = ${finish.status},
			files = ${sql.json(finish.files as never)},
			error = ${finish.error ?? null},
			finished_at = now()
		where order_id = ${orderId} and status = 'pending'
		returning *`
	return row && toOrderExport(row)
}

/** Appends files (the deletion certificate) to a finished export; `undefined` when missing */
export const appendOrderExportFiles = async (
	db: Db,
	orderId: string,
	files: OrderExportFile[]
): Promise<OrderExport | undefined> => {
	const { sql } = db
	const [row] = await sql<OrderExportRow[]>`
		update order_exports set files = files || ${sql.json(files as never)}
		where order_id = ${orderId}
		returning *`
	return row && toOrderExport(row)
}

export const createOrderExportsRepository = (db: Db): OrderExportsRepository => ({
	get: orderId => getOrderExport(db, orderId),
	claim: (claim, staleBefore, doneBefore) => claimOrderExport(db, claim, staleBefore, doneBefore),
	finish: (orderId, finish) => finishOrderExport(db, orderId, finish),
	appendFiles: (orderId, files) => appendOrderExportFiles(db, orderId, files),
})

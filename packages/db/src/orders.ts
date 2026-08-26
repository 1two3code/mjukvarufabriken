import type { ChatMessage, PartialSpec, SpecDraft, SpecStatus } from '@mf/models'
import type { Db } from './index.ts'
import type { OrdersRepository } from './repositories.ts'

// MARK: Row mapping

type OrderRow = {
	id: string
	org_id: string
	created_by: string | null
	status: SpecStatus
	spec: PartialSpec
	messages: ChatMessage[]
	open_questions: string[]
	size_class: 'S' | 'M' | 'L' | null
	price_sek: number | null
	frozen_at: Date | null
	created_at: Date
	updated_at: Date
}

export const toSpecDraft = (row: OrderRow): SpecDraft => ({
	orderId: row.id,
	orgId: row.org_id || undefined,
	status: row.status,
	spec: row.spec,
	messages: row.messages,
	openQuestions: row.open_questions,
	priceSek: row.price_sek ?? undefined,
	frozenAt: row.frozen_at?.toISOString(),
})

// MARK: Repository

export const getOrder = async (db: Db, orderId: string): Promise<SpecDraft | undefined> => {
	const [row] = await db.sql<OrderRow[]>`select * from orders where id = ${orderId}`
	return row && toSpecDraft(row)
}

export const listOrders = async (db: Db, filter: { orgId?: string } = {}): Promise<SpecDraft[]> => {
	const { sql } = db
	const rows = await sql<OrderRow[]>`
		select * from orders
		where true ${filter.orgId === undefined ? sql`` : sql`and org_id = ${filter.orgId}`}
		order by created_at desc
		limit 200`
	return rows.map(toSpecDraft)
}

/** Inserts or replaces the draft for `draft.orderId` (`created_by` is kept on update) */
export const upsertOrder = async (
	db: Db,
	draft: SpecDraft,
	createdBy?: string
): Promise<SpecDraft> => {
	const { sql } = db
	const [row] = await sql<OrderRow[]>`
		insert into orders (
			id, org_id, created_by, status, spec, messages, open_questions, size_class, price_sek, frozen_at
		)
		values (
			${draft.orderId}, ${draft.orgId ?? ''}, ${createdBy ?? null}, ${draft.status},
			${sql.json(draft.spec as never)}, ${sql.json(draft.messages as never)},
			${sql.json(draft.openQuestions as never)}, ${draft.spec.sizeClass ?? null},
			${draft.priceSek ?? null}, ${draft.frozenAt ? new Date(draft.frozenAt) : null}
		)
		on conflict (id) do update set
			org_id = excluded.org_id,
			status = excluded.status,
			spec = excluded.spec,
			messages = excluded.messages,
			open_questions = excluded.open_questions,
			size_class = excluded.size_class,
			price_sek = excluded.price_sek,
			frozen_at = excluded.frozen_at,
			updated_at = now()
		returning *`
	return toSpecDraft(row!)
}

export const createOrdersRepository = (db: Db): OrdersRepository => ({
	get: orderId => getOrder(db, orderId),
	list: filter => listOrders(db, filter),
	upsert: (draft, createdBy) => upsertOrder(db, draft, createdBy),
})

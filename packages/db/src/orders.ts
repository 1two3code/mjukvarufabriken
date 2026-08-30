import { toSpecStatus } from '@mf/models'

import { isUuid } from './jobs.ts'

import type {
	ChatMessage,
	LifecycleState,
	Order,
	OrderStatus,
	PartialSpec,
	Payment,
	SpecDraft,
} from '@mf/models'
import type { Db } from './index.ts'
import type { NewOrder, NewPayment, OrdersRepository, PaymentPaid } from './repositories.ts'

// MARK: Row mapping

type OrderRow = {
	id: string
	org_id: string
	created_by: string | null
	name: string
	status: OrderStatus
	spec: PartialSpec
	messages: ChatMessage[]
	open_questions: string[]
	size_class: 'S' | 'M' | 'L' | null
	price_sek: number | null
	frozen_at: Date | null
	approve_before_deliver: boolean
	lifecycle: LifecycleState
	lifecycle_changed_at: Date | null
	customer_slug: string | null
	created_at: Date
	updated_at: Date
}

type PaymentRow = {
	id: string
	order_id: string
	kind: Payment['kind']
	status: Payment['status']
	provider: Payment['provider']
	amount_sek: number
	vat_sek: number
	total_sek: number
	session_id: string
	event_id: string | null
	hosted_invoice_url: string | null
	receipt_url: string | null
	paid_at: Date | null
	created_at: Date
}

export const toSpecDraft = (row: OrderRow): SpecDraft => ({
	orderId: row.id,
	orgId: row.org_id || undefined,
	status: toSpecStatus(row.status),
	spec: row.spec,
	messages: row.messages,
	openQuestions: row.open_questions,
	priceSek: row.price_sek ?? undefined,
	frozenAt: row.frozen_at?.toISOString(),
})

export const toOrder = (row: OrderRow): Order => ({
	id: row.id,
	orgId: row.org_id,
	name: row.name,
	status: row.status,
	sizeClass: row.size_class ?? undefined,
	priceSek: row.price_sek ?? undefined,
	frozenAt: row.frozen_at?.toISOString(),
	approveBeforeDeliver: row.approve_before_deliver,
	createdBy: row.created_by ?? undefined,
	lifecycle: row.lifecycle,
	lifecycleChangedAt: row.lifecycle_changed_at?.toISOString(),
	customerSlug: row.customer_slug ?? undefined,
	createdAt: row.created_at.toISOString(),
	updatedAt: row.updated_at.toISOString(),
})

export const toPayment = (row: PaymentRow): Payment => ({
	id: row.id,
	orderId: row.order_id,
	kind: row.kind,
	status: row.status,
	provider: row.provider,
	amountSek: row.amount_sek,
	vatSek: row.vat_sek,
	totalSek: row.total_sek,
	sessionId: row.session_id,
	eventId: row.event_id ?? undefined,
	hostedInvoiceUrl: row.hosted_invoice_url ?? undefined,
	receiptUrl: row.receipt_url ?? undefined,
	paidAt: row.paid_at?.toISOString(),
	createdAt: row.created_at.toISOString(),
})

// MARK: Spec draft

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

/**
 * Inserts or replaces the draft for `draft.orderId` (`created_by` and `name` are kept on
 * update). The status column is only written while the order is still in its spec phase:
 * a draft's `frozen` never regresses an order that has moved on to payment or build.
 */
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
			status = case
				when orders.status in ('drafting', 'ready', 'frozen') then excluded.status
				else orders.status
			end,
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

/** The update half of `upsertOrder`, matching only a row still in its spec phase */
export const updateOrderUnlessFrozen = async (
	db: Db,
	draft: SpecDraft
): Promise<SpecDraft | undefined> => {
	const { sql } = db
	const [row] = await sql<OrderRow[]>`
		update orders set
			status = ${draft.status},
			spec = ${sql.json(draft.spec as never)},
			messages = ${sql.json(draft.messages as never)},
			open_questions = ${sql.json(draft.openQuestions as never)},
			size_class = ${draft.spec.sizeClass ?? null},
			price_sek = ${draft.priceSek ?? null},
			frozen_at = ${draft.frozenAt ? new Date(draft.frozenAt) : null},
			updated_at = now()
		where id = ${draft.orderId} and status in ('drafting', 'ready')
		returning *`
	return row && toSpecDraft(row)
}

// MARK: Order record (M6)

export const insertOrder = async (db: Db, order: NewOrder): Promise<Order> => {
	const [row] = await db.sql<OrderRow[]>`
		insert into orders (id, org_id, created_by, name)
		values (${order.id}, ${order.orgId}, ${order.createdBy ?? null}, ${order.name})
		returning *`
	return toOrder(row!)
}

export const getOrderRecord = async (db: Db, orderId: string): Promise<Order | undefined> => {
	const [row] = await db.sql<OrderRow[]>`select * from orders where id = ${orderId}`
	return row && toOrder(row)
}

export const listOrderRecords = async (
	db: Db,
	filter: { orgId?: string } = {}
): Promise<Order[]> => {
	const { sql } = db
	const rows = await sql<OrderRow[]>`
		select * from orders
		where true ${filter.orgId === undefined ? sql`` : sql`and org_id = ${filter.orgId}`}
		order by created_at desc
		limit 200`
	return rows.map(toOrder)
}

/** Compare-and-set on the status column: `undefined` when the row is missing or not in `from` */
export const transitionOrder = async (
	db: Db,
	orderId: string,
	from: readonly OrderStatus[],
	to: OrderStatus
): Promise<Order | undefined> => {
	const { sql } = db
	const [row] = await sql<OrderRow[]>`
		update orders set status = ${to}, updated_at = now()
		where id = ${orderId} and status in ${sql([...from])}
		returning *`
	return row && toOrder(row)
}

/** Toggles the approve-before-deliver gate (W7); `undefined` when the order is missing */
export const setApproveBeforeDeliver = async (
	db: Db,
	orderId: string,
	enabled: boolean
): Promise<Order | undefined> => {
	const [row] = await db.sql<OrderRow[]>`
		update orders set approve_before_deliver = ${enabled}, updated_at = now()
		where id = ${orderId}
		returning *`
	return row && toOrder(row)
}

// MARK: Lifecycle (wave 9, deprovisioning)

/**
 * Compare-and-set on the deprovisioning lifecycle, stamping `lifecycle_changed_at`. `from` guards
 * the transition (the grace-period sweep and the admin action both read-then-write): `undefined`
 * when the row is missing or its lifecycle is not in `from`. Writing the same state it already
 * holds is a no-op that still returns the row (idempotent), because the current state is in `from`.
 */
export const setLifecycle = async (
	db: Db,
	orderId: string,
	from: readonly LifecycleState[],
	to: LifecycleState
): Promise<Order | undefined> => {
	const { sql } = db
	const [row] = await sql<OrderRow[]>`
		update orders
			set lifecycle = ${to}, lifecycle_changed_at = now(), updated_at = now()
		where id = ${orderId} and lifecycle in ${sql([...from])}
		returning *`
	return row && toOrder(row)
}

/** Stores the per-customer fence slug on the order (set when the build starts); `undefined` when missing. */
export const setCustomerSlug = async (
	db: Db,
	orderId: string,
	customerSlug: string
): Promise<Order | undefined> => {
	const [row] = await db.sql<OrderRow[]>`
		update orders set customer_slug = ${customerSlug}, updated_at = now()
		where id = ${orderId}
		returning *`
	return row && toOrder(row)
}

/**
 * Suspended orders whose lifecycle last changed before `changedBefore` — the grace-period sweep's
 * candidates for promotion to `torn_down`. Oldest change first, capped like the other list reads.
 */
export const listSuspendedBefore = async (db: Db, changedBefore: Date): Promise<Order[]> => {
	const rows = await db.sql<OrderRow[]>`
		select * from orders
		where lifecycle = 'suspended' and lifecycle_changed_at is not null
			and lifecycle_changed_at < ${changedBefore}
		order by lifecycle_changed_at asc
		limit 200`
	return rows.map(toOrder)
}

// MARK: Payments (M6)

export const insertPayment = async (db: Db, payment: NewPayment): Promise<Payment> => {
	const [row] = await db.sql<PaymentRow[]>`
		insert into payments (order_id, kind, provider, amount_sek, vat_sek, total_sek, session_id)
		values (
			${payment.orderId}, ${payment.kind}, ${payment.provider}, ${payment.amountSek},
			${payment.vatSek}, ${payment.totalSek}, ${payment.sessionId}
		)
		returning *`
	return toPayment(row!)
}

export const getPayment = async (db: Db, id: string): Promise<Payment | undefined> => {
	if (!isUuid(id)) return undefined
	const [row] = await db.sql<PaymentRow[]>`select * from payments where id = ${id}`
	return row && toPayment(row)
}

export const findPaymentBySession = async (
	db: Db,
	sessionId: string
): Promise<Payment | undefined> => {
	const [row] = await db.sql<PaymentRow[]>`select * from payments where session_id = ${sessionId}`
	return row && toPayment(row)
}

export const listPayments = async (db: Db, orderId: string): Promise<Payment[]> => {
	const rows = await db.sql<PaymentRow[]>`
		select * from payments where order_id = ${orderId} order by created_at asc`
	return rows.map(toPayment)
}

/** Marks a pending payment paid; `undefined` when unknown or already paid (idempotent) */
export const markPaymentPaid = async (
	db: Db,
	id: string,
	paid: PaymentPaid
): Promise<Payment | undefined> => {
	if (!isUuid(id)) return undefined
	const [row] = await db.sql<PaymentRow[]>`
		update payments set
			status = 'paid',
			event_id = ${paid.eventId ?? null},
			hosted_invoice_url = ${paid.hostedInvoiceUrl ?? null},
			receipt_url = ${paid.receiptUrl ?? null},
			paid_at = now()
		where id = ${id} and status = 'pending'
		returning *`
	return row && toPayment(row)
}

/** Records the event id; false when it was already processed */
export const recordPaymentEvent = async (db: Db, eventId: string, type: string) => {
	const rows = await db.sql`
		insert into payment_events (id, type) values (${eventId}, ${type})
		on conflict (id) do nothing
		returning id`
	return rows.length > 0
}

export const forgetPaymentEvent = async (db: Db, eventId: string) => {
	await db.sql`delete from payment_events where id = ${eventId}`
}

export const createOrdersRepository = (db: Db): OrdersRepository => ({
	get: orderId => getOrder(db, orderId),
	list: filter => listOrders(db, filter),
	upsert: (draft, createdBy) => upsertOrder(db, draft, createdBy),
	updateUnlessFrozen: draft => updateOrderUnlessFrozen(db, draft),
	insert: order => insertOrder(db, order),
	getOrder: orderId => getOrderRecord(db, orderId),
	listOrders: filter => listOrderRecords(db, filter),
	transition: (orderId, from, to) => transitionOrder(db, orderId, from, to),
	setApproveBeforeDeliver: (orderId, enabled) =>
		setApproveBeforeDeliver(db, orderId, enabled),
	setLifecycle: (orderId, from, to) => setLifecycle(db, orderId, from, to),
	setCustomerSlug: (orderId, customerSlug) => setCustomerSlug(db, orderId, customerSlug),
	listSuspendedBefore: changedBefore => listSuspendedBefore(db, changedBefore),
	insertPayment: payment => insertPayment(db, payment),
	getPayment: id => getPayment(db, id),
	findPaymentBySession: sessionId => findPaymentBySession(db, sessionId),
	listPayments: orderId => listPayments(db, orderId),
	markPaymentPaid: (id, paid) => markPaymentPaid(db, id, paid),
	recordPaymentEvent: (eventId, type) => recordPaymentEvent(db, eventId, type),
	forgetPaymentEvent: eventId => forgetPaymentEvent(db, eventId),
})

import { anonymousOrgPrefix, toSpecStatus } from '@mf/models'

import { isUuid } from './jobs.ts'

import type {
	ChatMessage,
	LifecycleState,
	Order,
	OrderKind,
	OrderStatus,
	PartialSpec,
	Payment,
	SpecDraft,
} from '@mf/models'
import type { Db } from './index.ts'
import type {
	NewOrder,
	NewPayment,
	OrderOwner,
	OrdersRepository,
	PaymentPaid,
} from './repositories.ts'

// MARK: Row mapping

type OrderRow = {
	id: string
	org_id: string
	created_by: string | null
	name: string
	status: OrderStatus
	kind: OrderKind
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
	hosting_until: Date | null
	build_approved_at: Date | null
	/** sha256 of the anonymous quote token; never mapped onto the model (0025) */
	quote_token_hash: string | null
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
	kind: row.kind,
	sizeClass: row.size_class ?? undefined,
	priceSek: row.price_sek ?? undefined,
	frozenAt: row.frozen_at?.toISOString(),
	approveBeforeDeliver: row.approve_before_deliver,
	createdBy: row.created_by ?? undefined,
	lifecycle: row.lifecycle,
	lifecycleChangedAt: row.lifecycle_changed_at?.toISOString(),
	customerSlug: row.customer_slug ?? undefined,
	hostingUntil: row.hosting_until?.toISOString(),
	buildApprovedAt: row.build_approved_at?.toISOString(),
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
		insert into orders (id, org_id, created_by, name, kind, quote_token_hash)
		values (
			${order.id}, ${order.orgId}, ${order.createdBy ?? null}, ${order.name},
			${order.kind ?? 'build'}, ${order.quoteTokenHash ?? null}
		)
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

// MARK: Pricing ladder (wave 14)

/** Sets or clears (`null`) the end of the included hosting window; `undefined` when missing */
export const setHostingUntil = async (
	db: Db,
	orderId: string,
	hostingUntil: Date | null
): Promise<Order | undefined> => {
	const [row] = await db.sql<OrderRow[]>`
		update orders set hosting_until = ${hostingUntil}, updated_at = now()
		where id = ${orderId}
		returning *`
	return row && toOrder(row)
}

/**
 * Compare-and-set from "not yet approved": records the demo build approval instant only while
 * `build_approved_at` is null, so `undefined` means missing OR already approved (the first
 * approval wins).
 */
export const setBuildApprovedAt = async (
	db: Db,
	orderId: string,
	approvedAt: Date
): Promise<Order | undefined> => {
	const [row] = await db.sql<OrderRow[]>`
		update orders set build_approved_at = ${approvedAt}, updated_at = now()
		where id = ${orderId} and build_approved_at is null
		returning *`
	return row && toOrder(row)
}

/**
 * Active orders whose included hosting window ended at or before `until` — the scheduled-teardown
 * sweep's candidates, earliest end first (served by the partial `orders_hosting_until_idx`).
 */
export const listActiveWithHostingUntilBefore = async (db: Db, until: Date): Promise<Order[]> => {
	const rows = await db.sql<OrderRow[]>`
		select * from orders
		where lifecycle = 'active' and hosting_until is not null and hosting_until <= ${until}
		order by hosting_until asc
		limit 200`
	return rows.map(toOrder)
}

/** Compare-and-set from "no window yet": `undefined` when missing OR a window is already set */
export const initHostingUntil = async (
	db: Db,
	orderId: string,
	hostingUntil: Date
): Promise<Order | undefined> => {
	const [row] = await db.sql<OrderRow[]>`
		update orders set hosting_until = ${hostingUntil}, updated_at = now()
		where id = ${orderId} and hosting_until is null
		returning *`
	return row && toOrder(row)
}

/** Demo orders whose build was approved at or after `since` (the weekly voucher cap) */
export const countDemoApprovalsSince = async (db: Db, since: Date): Promise<number> => {
	const [row] = await db.sql<{ count: number | string }[]>`
		select count(*) as count from orders
		where kind = 'demo' and build_approved_at is not null and build_approved_at >= ${since}`
	return Number(row?.count ?? 0)
}

/**
 * Paid voucher demos waiting for a build approval, oldest first — the admin's demo queue. A
 * query of its own rather than a filter over the newest-200 `listOrderRecords` window: the
 * oldest waiting demo is exactly the row the queue exists to surface.
 */
export const listDemosAwaitingApproval = async (db: Db): Promise<Order[]> => {
	const rows = await db.sql<OrderRow[]>`
		select * from orders
		where kind = 'demo' and status = 'deposit_paid' and build_approved_at is null
		order by created_at asc
		limit 200`
	return rows.map(toOrder)
}

/**
 * Arbitrary constant, distinct from `migrationLockKey`: every demo approval takes the same
 * transaction-level advisory lock, so the week's count and the stamp serialise across approvals
 */
export const demoApprovalLockKey = 727_014

/**
 * Stamps a demo build approval under the weekly voucher cap in ONE serialised step: counts the
 * demo approvals since `window.since` and records `approvedAt` on the order only while that count
 * is below `window.cap` (no cap: an admin's `force`) and the order is not yet approved. Count and
 * stamp run in a transaction holding an advisory lock, so two concurrent approvals cannot both
 * read "one short of the cap" and both stamp — a plain count-then-update would (READ COMMITTED
 * gives each statement its own snapshot). `order` is undefined when the cap is full, the order is
 * missing, or it already carries an approval; `approved` is the count before this stamp, so the
 * caller can tell the cases apart by re-reading the row.
 */
export const stampDemoApproval = async (
	db: Db,
	orderId: string,
	approvedAt: Date,
	window: { since: Date; cap?: number }
): Promise<{ order: Order | undefined; approved: number }> => {
	const { sql } = db
	return sql.begin(async tx => {
		await tx`select pg_advisory_xact_lock(${demoApprovalLockKey})`
		const [count] = await tx<{ count: number | string }[]>`
			select count(*) as count from orders
			where kind = 'demo' and build_approved_at is not null
				and build_approved_at >= ${window.since}`
		const approved = Number(count?.count ?? 0)
		if (window.cap !== undefined && approved >= window.cap) return { order: undefined, approved }
		const [row] = await tx<OrderRow[]>`
			update orders set build_approved_at = ${approvedAt}, updated_at = now()
			where id = ${orderId} and build_approved_at is null
			returning *`
		return { order: row && toOrder(row), approved }
	})
}

// MARK: Anonymous quotes (wave 14, F1 — migration 0025)

/** The order when it still carries exactly this quote token hash (`undefined` otherwise) */
export const getOrderByQuoteToken = async (
	db: Db,
	orderId: string,
	tokenHash: string
): Promise<Order | undefined> => {
	const [row] = await db.sql<OrderRow[]>`
		select * from orders where id = ${orderId} and quote_token_hash = ${tokenHash}`
	return row && toOrder(row)
}

/**
 * Compare-and-set on the hash: the owner takes the row and the hash is cleared in one statement,
 * so two concurrent claims (or a replayed link) cannot both succeed.
 */
export const claimQuote = async (
	db: Db,
	orderId: string,
	tokenHash: string,
	owner: OrderOwner
): Promise<Order | undefined> => {
	const [row] = await db.sql<OrderRow[]>`
		update orders set
			org_id = ${owner.orgId},
			created_by = ${owner.userId},
			quote_token_hash = null,
			updated_at = now()
		where id = ${orderId} and quote_token_hash = ${tokenHash}
		returning *`
	return row && toOrder(row)
}

/** Drops still-anonymous orders older than the instant (served by `orders_anonymous_created_idx`) */
export const deleteAnonymousBefore = async (db: Db, createdBefore: Date): Promise<number> => {
	const deleted = await db.sql`
		delete from orders
		where org_id like ${`${anonymousOrgPrefix}%`} and created_at < ${createdBefore}`
	return deleted.count
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

// MARK: Margin (M12)

/** Distinct orgs with a non-cancelled order still in the `active` deprovisioning lifecycle */
export const listActiveOrgIds = async (db: Db): Promise<string[]> => {
	const rows = await db.sql<{ org_id: string }[]>`
		select distinct org_id from orders
		where lifecycle = 'active' and status <> 'cancelled' and org_id <> ''`
	return rows.map(row => row.org_id)
}

/** Per-org sum of paid payments (`deposit` + `balance`), ex moms */
export const sumPaidPaymentsByOrg = async (
	db: Db
): Promise<{ orgId: string; amountSek: number }[]> => {
	const rows = await db.sql<{ org_id: string; amount_sek: number | string }[]>`
		select o.org_id, sum(p.amount_sek) as amount_sek
		from payments p
		join orders o on o.id = p.order_id
		where p.status = 'paid'
		group by o.org_id`
	return rows.map(row => ({ orgId: row.org_id, amountSek: Number(row.amount_sek) }))
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
	setApproveBeforeDeliver: (orderId, enabled) => setApproveBeforeDeliver(db, orderId, enabled),
	setLifecycle: (orderId, from, to) => setLifecycle(db, orderId, from, to),
	setCustomerSlug: (orderId, customerSlug) => setCustomerSlug(db, orderId, customerSlug),
	listSuspendedBefore: changedBefore => listSuspendedBefore(db, changedBefore),
	setHostingUntil: (orderId, hostingUntil) => setHostingUntil(db, orderId, hostingUntil),
	setBuildApprovedAt: (orderId, approvedAt) => setBuildApprovedAt(db, orderId, approvedAt),
	listActiveWithHostingUntilBefore: until => listActiveWithHostingUntilBefore(db, until),
	countDemoApprovalsSince: since => countDemoApprovalsSince(db, since),
	listDemosAwaitingApproval: () => listDemosAwaitingApproval(db),
	stampDemoApproval: (orderId, approvedAt, window) =>
		stampDemoApproval(db, orderId, approvedAt, window),
	initHostingUntil: (orderId, hostingUntil) => initHostingUntil(db, orderId, hostingUntil),
	getOrderByQuoteToken: (orderId, tokenHash) => getOrderByQuoteToken(db, orderId, tokenHash),
	claimQuote: (orderId, tokenHash, owner) => claimQuote(db, orderId, tokenHash, owner),
	deleteAnonymousBefore: createdBefore => deleteAnonymousBefore(db, createdBefore),
	insertPayment: payment => insertPayment(db, payment),
	getPayment: id => getPayment(db, id),
	findPaymentBySession: sessionId => findPaymentBySession(db, sessionId),
	listPayments: orderId => listPayments(db, orderId),
	markPaymentPaid: (id, paid) => markPaymentPaid(db, id, paid),
	recordPaymentEvent: (eventId, type) => recordPaymentEvent(db, eventId, type),
	forgetPaymentEvent: eventId => forgetPaymentEvent(db, eventId),
	listActiveOrgIds: () => listActiveOrgIds(db),
	sumPaidPaymentsByOrg: () => sumPaidPaymentsByOrg(db),
})

import { z } from 'zod'

import { sizeClass } from './Spec.ts'

import type { SpecStatus } from './Spec.ts'

// MARK: Enums
/**
 * Order state machine (M6). The first three states are the spec phase and double as the
 * `SpecDraft.status` (`drafting` → `ready` → `frozen`); everything from `frozen` on is seen by
 * the spec engine as frozen. Transitions are enforced by `canTransitionOrder`.
 */
export const orderStatus = [
	'drafting',
	'ready',
	'frozen',
	'deposit_paid',
	'building',
	'awaiting_approval',
	'delivered',
	'paid',
	'cancelled',
] as const
export type OrderStatus = (typeof orderStatus)[number]

/**
 * Allowed transitions: from → to[]. `frozen → building` is the admin override (a build started
 * without the deposit); `deposit_paid`/`building → cancelled` is admin-only too (the running
 * build is killed and the deposit needs a refund) — see `customerCancellableOrderStatus`.
 *
 * `awaiting_approval` is the optional approve-before-deliver gate (per-order flag
 * `Order.approveBeforeDeliver`, default off, W7): once the build's job has delivered, an order
 * with the gate on parks in `awaiting_approval` — the gate reports and preview are shown and an
 * admin/customer must approve (`awaiting_approval → delivered`) before the order is delivered.
 * `building → delivered` stays legal so the default auto-deliver flow is unchanged.
 */
export const orderTransitions: Record<OrderStatus, readonly OrderStatus[]> = {
	drafting: ['ready', 'cancelled'],
	ready: ['drafting', 'frozen', 'cancelled'],
	frozen: ['deposit_paid', 'building', 'cancelled'],
	deposit_paid: ['building', 'cancelled'],
	building: ['awaiting_approval', 'delivered', 'cancelled'],
	awaiting_approval: ['delivered', 'cancelled'],
	delivered: ['paid'],
	paid: [],
	cancelled: [],
}

export const canTransitionOrder = (from: OrderStatus, to: OrderStatus) =>
	orderTransitions[from].includes(to)

/** True while the order sits at the approve-before-deliver gate awaiting a human approval */
export const isOrderAwaitingApproval = (status: OrderStatus) => status === 'awaiting_approval'

/** Statuses a customer may cancel from: until the deposit is paid. Admins may also cancel later. */
export const customerCancellableOrderStatus: readonly OrderStatus[] = [
	'drafting',
	'ready',
	'frozen',
]

/** Statuses in which the spec can still be edited */
export const specEditableOrderStatus = ['drafting', 'ready'] as const

/** True once the order is past the spec phase (the spec engine sees the draft as frozen) */
export const isOrderSpecFrozen = (status: OrderStatus) =>
	!(specEditableOrderStatus as readonly string[]).includes(status)

/** The order's status as the spec engine sees it: everything past the spec phase is frozen */
export const toSpecStatus = (status: OrderStatus): SpecStatus =>
	status === 'drafting' || status === 'ready' ? status : 'frozen'

/** Final states */
export const isOrderClosed = (status: OrderStatus) => status === 'paid' || status === 'cancelled'

// MARK: Order
export const OrderSchema = z.object({
	id: z.string(),
	orgId: z.string(),
	/** Customer-facing name, chosen when the order is created */
	name: z.string(),
	status: z.enum(orderStatus),
	sizeClass: z.enum(sizeClass).optional(),
	/** Fixed price in SEK ex moms, fixed when the spec is frozen */
	priceSek: z.number().int().nonnegative().optional(),
	frozenAt: z.iso.datetime().optional(),
	/**
	 * Approve-before-deliver gate (W7): when true, a delivered build parks the order in
	 * `awaiting_approval` for a human to approve before it is delivered. Default off (undefined ⇒
	 * the existing auto-deliver flow); toggled per order by an admin.
	 */
	approveBeforeDeliver: z.boolean().optional(),
	/**
	 * Id of the user who created the order. M5 delivery resolves the customer's GitHub login
	 * (M6 sign-in) from this user at delivery time rather than from a snapshot on the order
	 */
	createdBy: z.string().optional(),
	createdAt: z.iso.datetime(),
	updatedAt: z.iso.datetime(),
})
export type Order = z.infer<typeof OrderSchema>

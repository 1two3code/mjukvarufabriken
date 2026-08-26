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
	'delivered',
	'paid',
	'cancelled',
] as const
export type OrderStatus = (typeof orderStatus)[number]

/** Allowed transitions: from → to[] */
export const orderTransitions: Record<OrderStatus, readonly OrderStatus[]> = {
	drafting: ['ready', 'cancelled'],
	ready: ['drafting', 'frozen', 'cancelled'],
	frozen: ['deposit_paid', 'cancelled'],
	deposit_paid: ['building', 'cancelled'],
	building: ['delivered', 'cancelled'],
	delivered: ['paid'],
	paid: [],
	cancelled: [],
}

export const canTransitionOrder = (from: OrderStatus, to: OrderStatus) =>
	orderTransitions[from].includes(to)

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
	createdAt: z.iso.datetime(),
	updatedAt: z.iso.datetime(),
})
export type Order = z.infer<typeof OrderSchema>

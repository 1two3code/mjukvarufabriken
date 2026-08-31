import fp from 'fastify-plugin'
import {
	canTransitionOrder,
	customerCancellableOrderStatus,
	isActiveJobStatus,
	isFullUpfront,
	isSpecComplete,
	orderTransitions,
} from '@mf/models'

import { EntityInvalid, EntityNotFound } from '#/lib/entityError.ts'

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import type { BackendSession, Job, JobSummary, Order, OrderDetail, OrderStatus } from '@mf/models'

declare module 'fastify' {
	interface FastifyInstance {
		orderService: {
			/** Creates a `drafting` order owned by the session's org with an api-minted id */
			create: (name: string, session: BackendSession) => Promise<Order>
			/** The org's orders, newest first; admins see every org */
			list: (session: BackendSession) => Promise<Order[]>
			/** Org-scoped read; another org's order is EntityNotFound (admins see all) */
			get: (orderId: string, session: BackendSession) => Promise<Order>
			/** Order + spec status + latest job summary + payments, for the order page */
			getDetail: (orderId: string, session: BackendSession) => Promise<OrderDetail>
			/**
			 * Moves the order to `to`, enforcing the state machine server-side. Throws
			 * `InvalidOrderTransition` when the current status does not allow it.
			 */
			transition: (orderId: string, to: OrderStatus) => Promise<Order>
			/**
			 * Customer-facing order approval (W7): moves an `awaiting_approval` order to `delivered`.
			 * Org-scoped — a customer or an admin of the order's org may approve. Throws
			 * `InvalidOrderTransition` when the order is not awaiting approval. Note this approves the
			 * ORDER after the harness has already delivered the build; it is not a pre-delivery hold
			 * (see `syncWithJob`).
			 */
			approve: (orderId: string, session: BackendSession) => Promise<Order>
			/** Admin toggle of the per-order approval step (`approveBeforeDeliver`, W7) */
			setApprovalGate: (
				orderId: string,
				enabled: boolean,
				session: BackendSession
			) => Promise<Order>
			/**
			 * Cancels the order. Customers may cancel until the deposit is paid; admins also from
			 * `deposit_paid`/`building`. Any active build is killed and open Checkout sessions are
			 * expired so nothing can be paid for a cancelled order; a paid deposit is reported as a
			 * refund to do (warning in the log; admins refund in Stripe).
			 */
			cancel: (orderId: string, session: BackendSession) => Promise<Order>
		}
	}
}

/** The order's current status does not allow the requested transition */
export class InvalidOrderTransition extends EntityInvalid {
	// No parameter properties: Node runs the api with type stripping only (no transforms)
	readonly from: OrderStatus
	readonly to: OrderStatus
	constructor(orderId: string, from: OrderStatus, to: OrderStatus) {
		super('order', orderId)
		this.from = from
		this.to = to
		this.message = `order (${orderId}) cannot go from ${from} to ${to}`
	}
}

const isAdmin = (session: BackendSession) => session.role === 'admin'

/** Statuses that may transition to `to` — the inverse of `orderTransitions` */
export const transitionSources = (to: OrderStatus): OrderStatus[] =>
	(Object.keys(orderTransitions) as OrderStatus[]).filter(from => canTransitionOrder(from, to))

const toJobSummary = (job: Job): JobSummary => ({
	id: job.id,
	status: job.status,
	tokensUsed: job.tokensUsed,
	budget: job.budget,
	startedAt: job.startedAt,
	finishedAt: job.finishedAt,
	createdAt: job.createdAt,
})

const plugin: FastifyPluginAsync = async app => {
	const { db, jobService, paymentProvider } = app

	const scoped = (order: Order | undefined, session: BackendSession, id: string) => {
		if (!order || (!isAdmin(session) && order.orgId !== session.orgId)) {
			throw new EntityNotFound('order', id)
		}
		return order
	}

	const get: FastifyInstance['orderService']['get'] = async (orderId, session) =>
		scoped(await db.orders.getOrder(orderId), session, orderId)

	const transition: FastifyInstance['orderService']['transition'] = async (orderId, to) => {
		const current = await db.orders.getOrder(orderId)
		if (!current) throw new EntityNotFound('order', orderId)
		if (!canTransitionOrder(current.status, to)) {
			throw new InvalidOrderTransition(orderId, current.status, to)
		}
		// Compare-and-set against every legal source: a concurrent transition loses cleanly
		const updated = await db.orders.transition(orderId, transitionSources(to), to)
		if (!updated) {
			const latest = (await db.orders.getOrder(orderId))?.status ?? current.status
			throw new InvalidOrderTransition(orderId, latest, to)
		}
		return updated
	}

	/**
	 * The build's outcome moves the order on: a delivered job means the order is delivered and
	 * the balance can be invoiced. Applied lazily on read so no job-side hook is needed.
	 *
	 * Honest scope of `awaiting_approval` (W7): this is a customer-facing ORDER-approval step, not
	 * a pre-delivery hold. It only fires once `latest.status === 'delivered'`, i.e. the harness has
	 * ALREADY delivered (repo pushed / gone live). So parking in `awaiting_approval` gates the
	 * order-status/balance-invoice, not the build handover. A true pre-delivery HOLD (pausing the
	 * harness before repo push / go-live and resuming on approval) needs a harness change and is a
	 * follow-up out of this stream — do not read this as blocking delivery.
	 */
	const syncWithJob = async (order: Order, latest: Job | undefined) => {
		if (!latest || order.status !== 'building' || latest.status !== 'delivered') return order
		// With the per-order flag on, the (already-delivered) build parks the order for a human to
		// approve; without the flag the order auto-delivers exactly as before.
		const next: OrderStatus = order.approveBeforeDeliver ? 'awaiting_approval' : 'delivered'
		const updated = (await db.orders.transition(order.id, ['building'], next)) ?? order
		return settleFullUpfront(updated)
	}

	/**
	 * A full-upfront order (priced below the 3 000 kr threshold, pricing ladder 2026-08-31) has
	 * no balance payment: the whole price was in the upfront Checkout. Once such an order is
	 * `delivered` — and the upfront payment really is in, so an admin-override build (`frozen →
	 * building`, no payment) still invoices normally — it closes as `paid` right away.
	 */
	const settleFullUpfront = async (order: Order) => {
		if (order.status !== 'delivered') return order
		if (order.priceSek === undefined || !isFullUpfront(order.priceSek)) return order
		const payments = await db.orders.listPayments(order.id)
		const upfrontPaid = payments.some(
			payment => payment.kind === 'deposit' && payment.status === 'paid'
		)
		if (!upfrontPaid) return order
		return (await db.orders.transition(order.id, ['delivered'], 'paid')) ?? order
	}

	app.decorate('orderService', {
		get,
		transition,
		approve: async (orderId, session) => {
			const order = await get(orderId, session)
			if (order.status !== 'awaiting_approval') {
				throw new InvalidOrderTransition(orderId, order.status, 'delivered')
			}
			return settleFullUpfront(await transition(orderId, 'delivered'))
		},
		setApprovalGate: async (orderId, enabled, session) => {
			// Org-scoped read first: another org's order is EntityNotFound before any write
			await get(orderId, session)
			const updated = await db.orders.setApproveBeforeDeliver(orderId, enabled)
			if (!updated) throw new EntityNotFound('order', orderId)
			return updated
		},
		create: async (name, session) =>
			db.orders.insert({
				id: crypto.randomUUID(),
				orgId: session.orgId,
				name,
				createdBy: session.userId,
			}),
		list: session => db.orders.listOrders(isAdmin(session) ? {} : { orgId: session.orgId }),
		getDetail: async (orderId, session) => {
			const order = await get(orderId, session)
			const [draft, jobs, payments] = await Promise.all([
				db.orders.get(orderId),
				db.jobs.list({ orderId }),
				db.orders.listPayments(orderId),
			])
			const latest = jobs[0]
			return {
				order: await syncWithJob(order, latest),
				spec: {
					status: draft?.status ?? 'drafting',
					complete: isSpecComplete(draft?.spec),
					openQuestions: draft?.openQuestions.length ?? 0,
				},
				latestJob: latest && toJobSummary(latest),
				payments,
			}
		},
		cancel: async (orderId, session) => {
			const order = await get(orderId, session)
			if (!isAdmin(session) && !customerCancellableOrderStatus.includes(order.status)) {
				throw new InvalidOrderTransition(orderId, order.status, 'cancelled')
			}
			const cancelled = await transition(orderId, 'cancelled')

			// Nothing may keep spending or get paid for a cancelled order; each step is best effort
			// so a Stripe/ECS hiccup does not undo the cancel (the log line is the follow-up)
			const [jobs, payments] = await Promise.all([
				db.jobs.list({ orderId }),
				db.orders.listPayments(orderId),
			])
			for (const job of jobs.filter(job => isActiveJobStatus(job.status))) {
				await jobService.kill(job.id).catch(error => {
					app.log.error({ err: error, orderId, jobId: job.id }, 'Cancelled but could not kill')
				})
			}
			for (const payment of payments.filter(payment => payment.status === 'pending')) {
				await paymentProvider.expireSession(payment.sessionId).catch(error => {
					app.log.error(
						{ err: error, orderId, sessionId: payment.sessionId },
						'Cancelled but could not expire the Checkout session'
					)
				})
			}
			if (payments.some(payment => payment.status === 'paid')) {
				app.log.warn({ orderId }, 'Cancelled with a paid deposit — refund it in Stripe')
			}
			return cancelled
		},
	})
}

export default fp(plugin, {
	name: '#internal/orderService',
	dependencies: ['#internal/db', '#internal/jobService', '#internal/stripe'],
})

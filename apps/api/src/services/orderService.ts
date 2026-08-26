import fp from 'fastify-plugin'
import { canTransitionOrder, isSpecComplete, orderTransitions } from '@mf/models'

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
			/** Customer cancel: allowed until the deposit is paid */
			cancel: (orderId: string, session: BackendSession) => Promise<Order>
		}
	}
}

/** The order's current status does not allow the requested transition */
export class InvalidOrderTransition extends EntityInvalid {
	constructor(
		orderId: string,
		public from: OrderStatus,
		public to: OrderStatus
	) {
		super('order', orderId)
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
	const { db } = app

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
	 */
	const syncWithJob = async (order: Order, latest: Job | undefined) => {
		if (!latest || order.status !== 'building' || latest.status !== 'delivered') return order
		return (await db.orders.transition(order.id, ['building'], 'delivered')) ?? order
	}

	app.decorate('orderService', {
		get,
		transition,
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
			await get(orderId, session)
			return transition(orderId, 'cancelled')
		},
	})
}

export default fp(plugin, { name: '#internal/orderService', dependencies: ['#internal/db'] })

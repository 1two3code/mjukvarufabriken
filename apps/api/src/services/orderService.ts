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
import { hostingOf, latestDeliveredJob, toJobSummary } from '#/services/orderService.utils.ts'

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import type {
	BackendSession,
	DemoQueueResponse,
	Job,
	Order,
	OrderDetail,
	OrderHosting,
	OrderKind,
	OrderStatus,
} from '@mf/models'

declare module 'fastify' {
	interface FastifyInstance {
		orderService: {
			/**
			 * Creates a `drafting` order owned by the session's org with an api-minted id. `kind` is
			 * the pricing-ladder rung (wave 14), a real `build` unless asked otherwise.
			 */
			create: (name: string, session: BackendSession, kind?: OrderKind) => Promise<Order>
			/** The org's orders, newest first; admins see every org */
			list: (session: BackendSession) => Promise<Order[]>
			/** Org-scoped read; another org's order is EntityNotFound (admins see all) */
			get: (orderId: string, session: BackendSession) => Promise<Order>
			/**
			 * Order + spec status + job summaries (newest first) + what the customer actually got
			 * (`hosting`: live / unhosted / none) + payments, for the order page
			 */
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
			/**
			 * The one way a paid order's build starts: inserts and launches the job, moves the order
			 * to `building` and kicks off the (idempotent, fire-and-forget) customer AWS account
			 * provisioning. Shared by the deposit webhook and the demo approval so the two can never
			 * drift. Throws when the job cannot be started (the caller decides what that means).
			 */
			startBuild: (orderId: string, session: BackendSession) => Promise<void>
			/**
			 * Admin approval of a voucher demo's build (wave 14): a `demo` order in `deposit_paid`
			 * gets its `buildApprovedAt` stamped — while the rolling-week count of approvals is below
			 * `secrets.demoWeeklyCap`, or with `force` — and its build started like the webhook does
			 * for a real build. Throws `DemoNotApprovable` for the wrong kind/status and
			 * `DemoWeeklyCapReached` when the cap is full. An order approved earlier whose start
			 * failed is started again without a second approval instant.
			 */
			approveDemoBuild: (
				orderId: string,
				session: BackendSession,
				options?: { force?: boolean }
			) => Promise<Order>
			/** Paid demo orders waiting for a build approval, oldest first, plus the weekly cap state */
			demoQueue: () => Promise<DemoQueueResponse>
		}
	}
}

/** The rolling window the weekly voucher cap counts demo build approvals in */
export const demoCapWindowMs = 7 * 24 * 60 * 60 * 1000

/** Approve-build was called on an order that is not a paid demo waiting to start */
export class DemoNotApprovable extends EntityInvalid {
	constructor(orderId: string) {
		super('order', orderId)
		this.message = `order (${orderId}) is not a demo awaiting a build approval`
	}
}

/** The rolling week already holds `cap` approved demo builds; `force` bypasses it */
export class DemoWeeklyCapReached extends EntityInvalid {
	readonly approved: number
	readonly cap: number
	constructor(orderId: string, approved: number, cap: number) {
		super('order', orderId)
		this.approved = approved
		this.cap = cap
		this.message = `demo weekly cap reached (${approved}/${cap}) — order (${orderId}) not approved`
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

const plugin: FastifyPluginAsync = async app => {
	const { db, jobService, paymentProvider, accountService, secrets } = app

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
		return (await db.orders.transition(order.id, ['building'], next)) ?? order
	}

	/**
	 * A full-upfront order (priced below the 3 000 kr threshold, pricing ladder 2026-08-31) has
	 * no balance payment: the whole price was in the upfront Checkout. Once such an order is
	 * `delivered` — and the upfront payment really is in, so an admin-override build (`frozen →
	 * building`, no payment) still invoices normally — it closes as `paid` right away.
	 *
	 * Not while the delivery is `unhosted` (wave 14, F7): the customer bought a hosted app, and a
	 * delivery whose preview URL was withheld must not silently close the order. It stays
	 * `delivered` until a redelivery brings the preview up — this runs on every detail read of a
	 * `delivered` order (not only on the building → delivered move), so that read settles it.
	 */
	const settleFullUpfront = async (order: Order, hosting: OrderHosting) => {
		if (order.status !== 'delivered' || hosting.status === 'unhosted') return order
		if (order.priceSek === undefined || !isFullUpfront(order.priceSek)) return order
		const payments = await db.orders.listPayments(order.id)
		const upfrontPaid = payments.some(
			payment => payment.kind === 'deposit' && payment.status === 'paid'
		)
		if (!upfrontPaid) return order
		return (await db.orders.transition(order.id, ['delivered'], 'paid')) ?? order
	}

	// MARK: Build start (deposit webhook + demo approval)

	const startBuild: FastifyInstance['orderService']['startBuild'] = async (orderId, session) => {
		const order = await get(orderId, session)
		try {
			await jobService.start(orderId, session)
			await transition(orderId, 'building')
		} finally {
			// Fire-and-forget: real AWS account creation can take minutes (polled), so this must not
			// hold up a webhook response. Deliberately triggered here rather than at delivery time —
			// the build itself takes tens of minutes, plenty of lead time for the account to be ready
			// before delivery needs it. Idempotent and safe to retry (no-ops once an account is
			// recorded, or while PROVISION_CUSTOMER_ACCOUNTS is off); a failure here is an admin
			// follow-up (retry via the same admin endpoint), not a reason to fail the build.
			accountService.provisionCustomerAccount(order.orgId).catch(error => {
				app.log.error(
					{ err: error, orgId: order.orgId },
					'Build started but the AWS account could not be provisioned'
				)
			})
		}
	}

	/** Demo build approvals inside the rolling cap window, counted at `now` */
	const approvedThisWeek = (now: Date) =>
		db.orders.countDemoApprovalsSince(new Date(now.getTime() - demoCapWindowMs))

	const approveDemoBuild: FastifyInstance['orderService']['approveDemoBuild'] = async (
		orderId,
		session,
		{ force = false } = {}
	) => {
		const order = await get(orderId, session)
		if (order.kind !== 'demo' || order.status !== 'deposit_paid') {
			throw new DemoNotApprovable(orderId)
		}
		// A retry of an approved demo whose start failed keeps its first approval instant: it is
		// already counted against the week, a second stamp would count the same voucher twice
		if (!order.buildApprovedAt) {
			const now = new Date()
			const cap = secrets.demoWeeklyCap
			// Count and stamp in one serialised repository step: two admins (or two tabs) approving
			// different demos at once cannot both read "one short of the cap" and both get through
			const { order: stamped, approved } = await db.orders.stampDemoApproval(orderId, now, {
				since: new Date(now.getTime() - demoCapWindowMs),
				cap: force ? undefined : cap,
			})
			if (stamped) {
				app.log.info({ orderId, approved: approved + 1, cap, force }, 'Demo build approved')
			} else if (!(await get(orderId, session)).buildApprovedAt) {
				throw new DemoWeeklyCapReached(orderId, approved, cap)
			}
			// Otherwise a concurrent approval stamped first and wins the instant; this call still
			// goes on to start the build (a job already running is JobAlreadyActive, not a loss)
		}
		await startBuild(orderId, session)
		return get(orderId, session)
	}

	/** What the customer has of the order's jobs: the latest delivered one's deliverable, judged */
	const hostingFor = async (jobs: Job[]) => {
		const delivered = latestDeliveredJob(jobs)
		return hostingOf(delivered, delivered ? await db.jobs.listEvents(delivered.id) : [])
	}

	app.decorate('orderService', {
		get,
		transition,
		startBuild,
		approveDemoBuild,
		demoQueue: async () => {
			// A repository query, not a filter over the newest-200 `listOrders` window: the oldest
			// waiting demo is exactly the row the queue exists to surface
			const [orders, approved] = await Promise.all([
				db.orders.listDemosAwaitingApproval(),
				approvedThisWeek(new Date()),
			])
			return { orders, approvedThisWeek: approved, cap: secrets.demoWeeklyCap }
		},
		approve: async (orderId, session) => {
			const order = await get(orderId, session)
			if (order.status !== 'awaiting_approval') {
				throw new InvalidOrderTransition(orderId, order.status, 'delivered')
			}
			const hosting = await hostingFor(await db.jobs.list({ orderId }))
			return settleFullUpfront(await transition(orderId, 'delivered'), hosting)
		},
		setApprovalGate: async (orderId, enabled, session) => {
			// Org-scoped read first: another org's order is EntityNotFound before any write
			await get(orderId, session)
			const updated = await db.orders.setApproveBeforeDeliver(orderId, enabled)
			if (!updated) throw new EntityNotFound('order', orderId)
			return updated
		},
		create: async (name, session, kind = 'build') =>
			db.orders.insert({
				id: crypto.randomUUID(),
				orgId: session.orgId,
				name,
				kind,
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
			const hosting = await hostingFor(jobs)
			return {
				order: await settleFullUpfront(await syncWithJob(order, latest), hosting),
				spec: {
					status: draft?.status ?? 'drafting',
					complete: isSpecComplete(draft?.spec),
					openQuestions: draft?.openQuestions.length ?? 0,
				},
				latestJob: latest && toJobSummary(latest),
				jobs: jobs.map(toJobSummary),
				hosting,
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
	dependencies: [
		'#internal/db',
		'#internal/secrets',
		'#internal/jobService',
		'#internal/stripe',
		'#internal/accountService',
	],
})

import { createHash } from 'node:crypto'

import fp from 'fastify-plugin'
import { canTransitionOrder, paymentAmounts, usdCentsOf } from '@mf/models'

import { EntityInvalid, EntityNotFound } from '#/lib/entityError.ts'
import { InvalidWebhookSignature } from '#/plugins/stripe.ts'

import type { FastifyPluginAsync } from 'fastify'
import type {
	BackendSession,
	CheckoutResponse,
	OrderStatus,
	Payment,
	PaymentKind,
	PaymentProvider,
	ResidentBillingResult,
	ResidentBillingRunResponse,
	ResidentUsageSummary,
} from '@mf/models'
import type { PaymentEvent } from '#/plugins/stripe.ts'

declare module 'fastify' {
	interface FastifyInstance {
		paymentService: {
			/**
			 * Creates a pending payment for the order and a Checkout session for it. The deposit
			 * needs a frozen order, the balance a delivered one; a kind already paid is rejected.
			 * Any earlier open session of the same kind is expired first, so the customer can only
			 * ever pay one of them.
			 */
			checkout: (
				orderId: string,
				kind: PaymentKind,
				session: BackendSession
			) => Promise<CheckoutResponse>
			/**
			 * Verifies and applies one webhook delivery: idempotent on the event id, marks the
			 * session's payment paid, moves the order on and, for the deposit, starts the build.
			 * A failure while applying forgets the event id again so Stripe's retry is processed.
			 */
			handleWebhook: (rawBody: string, signature: string | undefined) => Promise<WebhookResult>
			/**
			 * The fake provider's "payment": marks the session paid the same way a webhook would.
			 * Org-scoped like the order; rejects unless the fake provider is active.
			 */
			completeFakeSession: (sessionId: string, session: BackendSession) => Promise<Payment>
			/**
			 * Resident usage-based billing (M8): reports each installation's billable cents for
			 * the month to the provider's meter. Idempotent — the cumulative reported amount is
			 * stored per installation and month, so a re-run only reports what came in since
			 * (nothing when the month is unchanged). Each report is reserved on the row before
			 * the provider is called and confirmed after: a run that dies in between is retried
			 * with the same event, and a concurrent run loses the compare-and-set
			 * (`in_progress`). Installations without a billing customer are skipped
			 * (`no_customer`) unless the fake provider is active; reports made through another
			 * provider do not count. A month whose total fell below what was reported is flagged
			 * `overreported` — the credit is an admin's job at the provider.
			 */
			billResidentUsage: (month: string) => Promise<ResidentBillingRunResponse>
			/** The provider in use, so the portal can label the fake one */
			provider: PaymentProvider
		}
	}
}

export type WebhookResult = {
	eventId: string
	/**
	 * `applied` = payment marked paid now; `duplicate` = seen before; `ignored` = other event;
	 * `refund_due` = money taken for a session the order can no longer take (paid twice, or
	 * cancelled meanwhile) — the admins are emailed
	 */
	outcome: 'applied' | 'duplicate' | 'ignored' | 'refund_due'
	payment?: Payment
}

/** The order is not in the status the payment kind requires (or the kind is already paid) */
export class PaymentNotDue extends EntityInvalid {
	constructor(orderId: string, kind: PaymentKind) {
		super('payment', `${orderId}/${kind}`)
	}
}

/** Only the fake provider has a local checkout page */
export class FakeProviderInactive extends EntityInvalid {
	constructor() {
		super('payment', 'fake')
	}
}

export { InvalidWebhookSignature }

/** Order status a payment of each kind requires, and the status it moves the order to */
export const paymentFlow: Record<PaymentKind, { from: OrderStatus; to: OrderStatus }> = {
	deposit: { from: 'frozen', to: 'deposit_paid' },
	balance: { from: 'delivered', to: 'paid' },
}

/** Webhook event types that carry a paid session (see `PaymentEvent.sessionId`) */
export const paidSessionEvents = new Set([
	'checkout.session.completed',
	'checkout.session.async_payment_succeeded',
])

/** System session the webhook uses to start the build on the customer's behalf */
const webhookSession = (orgId: string): BackendSession => ({
	userId: 'stripe-webhook',
	role: 'admin',
	orgId,
})

const isUniqueViolation = (error: unknown) => (error as { code?: string })?.code === '23505'

/** Stripe rejects meter event identifiers longer than this */
export const maxUsageIdentifierLength = 100

/**
 * How long a pending report counts as in flight (its run may still be at the provider or
 * confirming); after that a run that died mid-way is assumed and the report is retried
 */
export const usageReportInFlightMs = 5 * 60_000

/**
 * The idempotency key of one usage report: the cumulative cents in it make a retry of the
 * same report a no-op at the provider. A long installation id is replaced by its hash so
 * the key stays within the provider's limit (the installation stays billable)
 */
export const usageReportIdentifier = (
	installationId: string,
	month: string,
	totalUsdCents: number
) => {
	const identifier = `${installationId}/${month}/${totalUsdCents}`
	if (identifier.length <= maxUsageIdentifierLength) return identifier
	const hash = createHash('sha256').update(installationId).digest('hex').slice(0, 32)
	return `${hash}/${month}/${totalUsdCents}`
}

type Applied = { payment: Payment; refundDue: boolean }

const plugin: FastifyPluginAsync = async app => {
	const {
		db,
		paymentProvider,
		orderService,
		jobService,
		userService,
		residentService,
		accountService,
		secrets,
		email,
	} = app

	const orderPageUrl = (orderId: string) => `${secrets.portalUrl}/orders/${orderId}`

	const customerEmail = async (session: BackendSession) => {
		try {
			return (await userService.get(session.userId)).email
		} catch {
			return undefined
		}
	}

	/** Money has arrived that the order cannot take: an admin refunds it in Stripe */
	const flagRefund = async (payment: Payment, reason: string) => {
		app.log.error({ orderId: payment.orderId, paymentId: payment.id, reason }, 'REFUND DUE')
		const text = [
			`Order ${payment.orderId}: ${payment.kind} of ${payment.totalSek} SEK (session ${payment.sessionId}) needs a refund.`,
			reason,
			`Order page: ${orderPageUrl(payment.orderId)}`,
		].join('\n\n')
		await Promise.allSettled(
			secrets.authAdminEmails.map(to =>
				email.send({ to, subject: `Refund due: order ${payment.orderId}`, text })
			)
		)
	}

	/**
	 * Marks the session's payment paid and moves the order on. `undefined` when the session is
	 * unknown / already paid (a redelivery of an applied event); `refundDue` when the money came
	 * in for a session the order can no longer take.
	 */
	const applyPaidSession = async (
		sessionId: string,
		eventId: string
	): Promise<Applied | undefined> => {
		const pending = await db.orders.findPaymentBySession(sessionId)
		if (!pending || pending.status === 'paid') return undefined

		const receipts = await paymentProvider.getSessionReceipts(sessionId).catch(error => {
			app.log.warn({ err: error, sessionId }, 'Could not fetch the invoice/receipt urls')
			return {}
		})
		let payment: Payment | undefined
		try {
			payment = await db.orders.markPaymentPaid(pending.id, { eventId, ...receipts })
		} catch (error) {
			// payments_one_paid_per_kind: this kind was already paid through another session
			if (!isUniqueViolation(error)) throw error
			await flagRefund(pending, `The ${pending.kind} was already paid through another session.`)
			return { payment: pending, refundDue: true }
		}
		if (!payment) return undefined

		const { to } = paymentFlow[payment.kind]
		const order = await db.orders.getOrder(payment.orderId)
		if (!order || order.status === 'cancelled') {
			await flagRefund(payment, 'The order was cancelled before the payment completed.')
			return { payment, refundDue: true }
		}
		if (!canTransitionOrder(order.status, to)) {
			// e.g. an admin already started the build without the deposit: the money is in and the
			// order is further along than the payment expects — nothing to move
			app.log.warn({ orderId: order.id, status: order.status }, `Paid; order not moved to ${to}`)
			return { payment, refundDue: false }
		}
		try {
			await orderService.transition(order.id, to)
		} catch (error) {
			// The money is in either way; a stale order status is an admin follow-up, not a retry
			app.log.error({ err: error, orderId: order.id }, `Paid but could not move to ${to}`)
			return { payment, refundDue: false }
		}
		if (payment.kind === 'deposit') await startBuild(order.id, order.orgId)
		return { payment, refundDue: false }
	}

	/** Deposit paid → the build starts on its own */
	const startBuild = async (orderId: string, orgId: string) => {
		try {
			await jobService.start(orderId, webhookSession(orgId))
			await orderService.transition(orderId, 'building')
		} catch (error) {
			app.log.error({ err: error, orderId }, 'Deposit paid but the build could not be started')
		}
		// Fire-and-forget: real AWS account creation can take minutes (polled), so this must not
		// hold up the webhook response. Deliberately triggered here rather than at delivery time —
		// the build itself takes tens of minutes, plenty of lead time for the account to be ready
		// before delivery needs it. Idempotent and safe to retry (no-ops once an account is
		// recorded, or while PROVISION_CUSTOMER_ACCOUNTS is off); a failure here is an admin
		// follow-up (retry via the same admin endpoint), not a reason to fail the build.
		accountService.provisionCustomerAccount(orgId).catch(error => {
			app.log.error({ err: error, orgId }, 'Deposit paid but the AWS account could not be provisioned')
		})
	}

	const handleEvent = async (event: PaymentEvent): Promise<WebhookResult> => {
		const fresh = await db.orders.recordPaymentEvent(event.id, event.type)
		if (!fresh) return { eventId: event.id, outcome: 'duplicate' }
		if (!paidSessionEvents.has(event.type) || !event.sessionId) {
			if (event.type === 'checkout.session.async_payment_failed') {
				app.log.warn({ eventId: event.id }, 'Delayed payment failed; the session stays pending')
			}
			return { eventId: event.id, outcome: 'ignored' }
		}
		let applied: Applied | undefined
		try {
			applied = await applyPaidSession(event.sessionId, event.id)
		} catch (error) {
			// Not applied: forget the id so the provider's redelivery is processed, not deduped
			await db.orders.forgetPaymentEvent(event.id).catch(forgetError => {
				app.log.error({ err: forgetError, eventId: event.id }, 'Could not forget the event id')
			})
			throw error
		}
		if (!applied) return { eventId: event.id, outcome: 'duplicate' }
		return {
			eventId: event.id,
			outcome: applied.refundDue ? 'refund_due' : 'applied',
			payment: applied.payment,
		}
	}

	// MARK: Resident usage billing (M8)

	/** Reports the month's unbilled cents of one installation; never throws */
	const billInstallation = async (
		summary: ResidentUsageSummary
	): Promise<ResidentBillingResult> => {
		const { installationId, month } = summary
		const provider = paymentProvider.kind
		const totalUsdCents = usdCentsOf(summary.billableUsd)
		// A report of another provider never reached this one: its months are unbilled here
		const report = summary.report?.provider === provider ? summary.report : undefined
		if (summary.report && !report) {
			app.log.warn(
				{ installationId, month, reportProvider: summary.report.provider, provider },
				'resident usage report of another provider ignored'
			)
		}
		const reportedUsdCents = report?.usdCents ?? 0
		// An unconfirmed reservation is retried as-is: same cents, same identifier → the provider
		// dedupes it if the earlier attempt did go through. New usage waits for the next run.
		const pending =
			report?.pendingUsdCents !== undefined && report.pendingIdentifier !== undefined
				? { toUsdCents: report.pendingUsdCents, identifier: report.pendingIdentifier }
				: {
						toUsdCents: totalUsdCents,
						identifier: usageReportIdentifier(installationId, month, totalUsdCents),
					}
		const usdCents = pending.toUsdCents - reportedUsdCents
		const unchanged = {
			installationId,
			outcome: 'unchanged',
			usdCents: 0,
			totalUsdCents: reportedUsdCents,
		} as const
		const inFlightSince = report?.pendingAt && Date.parse(report.pendingAt)
		if (inFlightSince && Date.now() - inFlightSince < usageReportInFlightMs) {
			return {
				...unchanged,
				outcome: 'in_progress',
				reason: `A report of ${pending.toUsdCents} cents is in flight since ${report?.pendingAt}`,
			}
		}
		if (usdCents < 0) {
			// A corrected (lower) day: the meter cannot be reduced from here, an admin credits it
			const creditUsdCents = -usdCents
			app.log.warn({ installationId, month, creditUsdCents }, 'resident usage OVERREPORTED')
			return {
				...unchanged,
				outcome: 'overreported',
				reason: `Reported ${reportedUsdCents} cents, the month now totals ${pending.toUsdCents}: credit ${creditUsdCents} cents at the provider`,
			}
		}
		if (usdCents === 0) return unchanged

		const installation = await db.resident.getInstallation(installationId)
		const customerId = installation?.billingCustomerId
		if (!customerId && provider !== 'fake') {
			return {
				...unchanged,
				outcome: 'no_customer',
				reason: 'No billing customer id on the installation',
			}
		}
		// Reserve first: the row records what is about to be sent, and a stale read or a
		// concurrent run fails the compare-and-set instead of reporting the same cents twice
		const reserved = await db.resident.reserveUsageReport({
			installationId,
			month,
			provider,
			fromUsdCents: reportedUsdCents,
			toUsdCents: pending.toUsdCents,
			identifier: pending.identifier,
		})
		if (!reserved) {
			return {
				...unchanged,
				outcome: 'in_progress',
				reason: 'Another billing run holds this month — re-run to pick up its result',
			}
		}
		try {
			const { reference } = await paymentProvider.reportUsage({
				installationId,
				month,
				customerId,
				usdCents,
				identifier: pending.identifier,
			})
			const confirmed = await db.resident.confirmUsageReport(
				installationId,
				month,
				pending.identifier,
				reference
			)
			if (!confirmed) throw new Error('The reservation was taken over by another run')
			app.log.info({ installationId, month, usdCents, reference }, 'resident usage reported')
			return {
				installationId,
				outcome: 'reported',
				usdCents,
				totalUsdCents: confirmed.usdCents,
			}
		} catch (error) {
			// The reservation stays: the next run retries the identical event (at once when the
			// release lands, after the in-flight timeout when the database is the problem)
			app.log.error({ err: error, installationId, month }, 'resident usage report failed')
			await db.resident
				.releaseUsageReport(installationId, month, pending.identifier)
				.catch(releaseError => {
					app.log.error({ err: releaseError, installationId, month }, 'Could not release')
				})
			return { ...unchanged, outcome: 'failed', reason: (error as Error).message }
		}
	}

	app.decorate('paymentService', {
		provider: paymentProvider.kind,
		billResidentUsage: async month => {
			const summaries = await residentService.summarizeUsage({ month })
			const results: ResidentBillingResult[] = []
			// Sequential: one meter event at a time keeps the provider's rate limit and the log readable
			for (const summary of summaries) results.push(await billInstallation(summary))
			return { month, provider: paymentProvider.kind, results }
		},
		checkout: async (orderId, kind, session) => {
			// getDetail syncs the order with its latest job (building → delivered) before the gate
			const { order, payments } = await orderService.getDetail(orderId, session)
			if (order.status !== paymentFlow[kind].from || order.priceSek === undefined) {
				throw new PaymentNotDue(orderId, kind)
			}
			const sameKind = payments.filter(payment => payment.kind === kind)
			if (sameKind.some(payment => payment.status === 'paid')) {
				throw new PaymentNotDue(orderId, kind)
			}
			// One payable session per kind: close the earlier ones (a second tab, a retry)
			for (const stale of sameKind.filter(payment => payment.status === 'pending')) {
				await paymentProvider.expireSession(stale.sessionId).catch(error => {
					app.log.warn({ err: error, sessionId: stale.sessionId }, 'Could not expire session')
				})
			}

			const amounts = paymentAmounts(order.priceSek, kind)
			const paymentId = crypto.randomUUID()
			const checkout = await paymentProvider.createCheckoutSession({
				paymentId,
				orderId,
				orderName: order.name || orderId,
				kind,
				amountSek: amounts.amountSek,
				vatSek: amounts.vatSek,
				customerEmail: await customerEmail(session),
				successUrl: `${orderPageUrl(orderId)}?payment=success&kind=${kind}`,
				cancelUrl: `${orderPageUrl(orderId)}?payment=cancelled&kind=${kind}`,
			})
			const payment = await db.orders.insertPayment({
				orderId,
				kind,
				provider: paymentProvider.kind,
				...amounts,
				sessionId: checkout.sessionId,
			})
			return { payment, url: checkout.url }
		},
		handleWebhook: async (rawBody, signature) =>
			handleEvent(paymentProvider.constructWebhookEvent(rawBody, signature)),
		completeFakeSession: async (sessionId, session) => {
			if (paymentProvider.kind !== 'fake') throw new FakeProviderInactive()
			const pending = await db.orders.findPaymentBySession(sessionId)
			if (!pending) throw new EntityNotFound('payment', sessionId)
			// Org-scoped: another org's session is as unknown as a missing one
			await orderService.get(pending.orderId, session).catch(() => {
				throw new EntityNotFound('payment', sessionId)
			})
			const result = await handleEvent({
				id: `evt_fake_${sessionId}`,
				type: 'checkout.session.completed',
				sessionId,
			})
			return result.payment ?? pending
		},
	})
}

export default fp(plugin, {
	name: '#internal/paymentService',
	dependencies: [
		'#internal/db',
		'#internal/stripe',
		'#internal/secrets',
		'#internal/email',
		'#internal/orderService',
		'#internal/jobService',
		'#internal/userService',
		'#internal/residentService',
		'#internal/accountService',
	],
})

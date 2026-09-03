import { EntityNotFound } from '#/lib/entityError.ts'
import { createMockJob } from '#/plugins/__mocks__/db.ts'
import { createMockPaymentEvent, mockSessionId } from '#/plugins/__mocks__/stripe.ts'
import { createMockResidentUsageRecord } from '#/services/__mocks__/residentService.ts'
import { InvalidOrderTransition } from '#/services/orderService.ts'
import {
	FakeProviderInactive,
	maxUsageIdentifierLength,
	PaymentNotDue,
	usageReportIdentifier,
	usageReportInFlightMs,
} from '#/services/paymentService.ts'

import type { FastifyInstance } from 'fastify'
import type { BackendSession, Order, OrderStatus } from '@mf/models'
import type { FakePaymentProvider } from '#/plugins/stripe.ts'

const user: BackendSession = { userId: 'user-1', role: 'user', orgId: 'org-1' }

/** Runs the real order service too, so the state machine is exercised end to end */
const createApp = () =>
	createTestApp({ skipMock: ['#/services/paymentService.ts', '#/services/orderService.ts'] })

describe('Payment Service', () => {
	let app: FastifyInstance

	const createOrder = async (status: OrderStatus, priceSek = 4_000): Promise<Order> => {
		const order = await app.orderService.create('Gym booking', user)
		const draft = (await app.db.orders.get(order.id))!
		await app.db.orders.upsert({ ...draft, status: 'frozen', priceSek })
		const path: OrderStatus[] = ['deposit_paid', 'building', 'delivered', 'paid']
		for (const step of path.slice(0, path.indexOf(status) + 1)) {
			await app.orderService.transition(order.id, step)
		}
		return app.orderService.get(order.id, user)
	}

	beforeEach(async () => {
		app = await createApp()
		vi.spyOn(app.db.jobs, 'list').mockResolvedValue([])
	})

	describe('checkout', () => {
		it('Creates a Checkout session for 50 % of the price with moms as its own line', async () => {
			const order = await createOrder('frozen')

			const result = await app.paymentService.checkout(order.id, 'deposit', user)

			expect(app.paymentProvider.createCheckoutSession).toHaveBeenCalledWith({
				paymentId: expect.any(String),
				orderId: order.id,
				orderName: 'Gym booking',
				kind: 'deposit',
				share: 0.5,
				amountSek: 2_000,
				vatSek: 500,
				customerEmail: 'farnsworth@planetexpress.example',
				successUrl: `https://portal.example.com/orders/${order.id}?payment=success&kind=deposit`,
				cancelUrl: `https://portal.example.com/orders/${order.id}?payment=cancelled&kind=deposit`,
			})
			expect(result.url).toBe('https://checkout.stripe.com/c/pay/cs_test_123')
			expect(result.payment).toMatchObject({
				orderId: order.id,
				kind: 'deposit',
				status: 'pending',
				provider: 'stripe',
				amountSek: 2_000,
				vatSek: 500,
				totalSek: 2_500,
				sessionId: mockSessionId,
			})
			await expect(app.db.orders.listPayments(order.id)).resolves.toHaveLength(1)
		})

		it('Only allows the deposit on a frozen order and the balance on a delivered one', async () => {
			const drafting = await app.orderService.create('x', user)
			await expect(
				app.paymentService.checkout(drafting.id, 'deposit', user)
			).rejects.toBeInstanceOf(PaymentNotDue)

			const frozen = await createOrder('frozen')
			await expect(app.paymentService.checkout(frozen.id, 'balance', user)).rejects.toBeInstanceOf(
				PaymentNotDue
			)

			const delivered = await createOrder('delivered')
			await expect(
				app.paymentService.checkout(delivered.id, 'balance', user)
			).resolves.toMatchObject({ payment: { kind: 'balance' } })
		})

		it('Charges the whole price upfront for an order below 3 000 kr and never a balance', async () => {
			// A 500 kr demo build: one Checkout for 100 %, no 50/50 split
			const order = await createOrder('frozen', 500)

			const result = await app.paymentService.checkout(order.id, 'deposit', user)

			expect(result.payment).toMatchObject({
				kind: 'deposit',
				amountSek: 500,
				vatSek: 125,
				totalSek: 625,
			})
			// The provider is told this is the whole price (share 1) so the Stripe Checkout page
			// and its invoice/receipt are labelled "Payment 100 %", not "Deposit 50 %"
			expect(app.paymentProvider.createCheckoutSession).toHaveBeenCalledWith(
				expect.objectContaining({ share: 1, amountSek: 500, vatSek: 125 })
			)

			// Even a delivered full-upfront order has no balance to pay
			const delivered = await createOrder('delivered', 500)
			await expect(
				app.paymentService.checkout(delivered.id, 'balance', user)
			).rejects.toBeInstanceOf(PaymentNotDue)
		})

		it('Expires the earlier open session of the same kind so only one can be paid', async () => {
			const order = await createOrder('frozen')
			const first = await app.paymentService.checkout(order.id, 'deposit', user)
			vi.mocked(app.paymentProvider.expireSession).mockRejectedValueOnce(new Error('down'))

			// A second tab / retry: the first session is closed, a Stripe hiccup is not fatal
			const second = await app.paymentService.checkout(order.id, 'deposit', user)

			expect(app.paymentProvider.expireSession).toHaveBeenCalledTimes(1)
			expect(app.paymentProvider.expireSession).toHaveBeenCalledWith(first.payment.sessionId)
			expect(second.payment.sessionId).not.toBe(first.payment.sessionId)
			await expect(app.db.orders.listPayments(order.id)).resolves.toHaveLength(2)
		})

		it('Sees a delivered build before gating the balance, without a prior order page read', async () => {
			const order = await createOrder('building')
			vi.spyOn(app.db.jobs, 'list').mockResolvedValue([
				createMockJob({ orderId: order.id, status: 'delivered' }),
			])

			await expect(app.paymentService.checkout(order.id, 'balance', user)).resolves.toMatchObject({
				payment: { kind: 'balance' },
			})
			await expect(app.orderService.get(order.id, user)).resolves.toMatchObject({
				status: 'delivered',
			})
		})

		it("Rejects a frozen order without a price and another org's order", async () => {
			const order = await app.orderService.create('x', user)
			await app.orderService.transition(order.id, 'ready')
			await app.orderService.transition(order.id, 'frozen')
			await expect(app.paymentService.checkout(order.id, 'deposit', user)).rejects.toBeInstanceOf(
				PaymentNotDue
			)
			await expect(
				app.paymentService.checkout(order.id, 'deposit', { ...user, orgId: 'org-2' })
			).rejects.toBeInstanceOf(EntityNotFound)
		})
	})

	describe('handleWebhook', () => {
		const paidDeposit = async () => {
			const order = await createOrder('frozen')
			const { payment } = await app.paymentService.checkout(order.id, 'deposit', user)
			const result = await app.paymentService.handleWebhook('{}', 'sig')
			return { order, payment, result }
		}

		it('Verifies the signature, marks the deposit paid with the receipts and starts the build', async () => {
			const { order, payment, result } = await paidDeposit()

			expect(app.paymentProvider.constructWebhookEvent).toHaveBeenCalledWith('{}', 'sig')
			expect(result.outcome).toBe('applied')
			expect(result.payment).toMatchObject({
				id: payment.id,
				status: 'paid',
				eventId: 'evt_1',
				hostedInvoiceUrl: 'https://invoice.stripe.com/i/inv_1',
				receiptUrl: 'https://pay.stripe.com/receipts/r_1',
				paidAt: expect.any(String),
			})
			expect(app.jobService.start).toHaveBeenCalledWith(order.id, {
				userId: 'stripe-webhook',
				role: 'admin',
				orgId: 'org-1',
			})
			expect(app.accountService.provisionCustomerAccount).toHaveBeenCalledWith('org-1')
			await expect(app.orderService.get(order.id, user)).resolves.toMatchObject({
				status: 'building',
			})
		})

		it('Leaves a paid voucher demo in deposit_paid for an admin approval — no auto-start', async () => {
			// A 500 kr demo: the whole price in one Checkout, then a human approves the build
			const order = await app.orderService.create('Demo', user, 'demo')
			const draft = (await app.db.orders.get(order.id))!
			await app.db.orders.upsert({ ...draft, status: 'frozen', priceSek: 500 })
			const { payment } = await app.paymentService.checkout(order.id, 'deposit', user)

			const result = await app.paymentService.handleWebhook('{}', 'sig')

			expect(result).toMatchObject({
				outcome: 'applied',
				payment: { id: payment.id, status: 'paid' },
			})
			expect(app.jobService.start).not.toHaveBeenCalled()
			expect(app.accountService.provisionCustomerAccount).not.toHaveBeenCalled()
			const paid = await app.orderService.get(order.id, user)
			expect(paid).toMatchObject({ kind: 'demo', status: 'deposit_paid' })
			expect(paid.buildApprovedAt).toBeUndefined()
		})

		it('Does not fail the webhook when AWS account provisioning rejects', async () => {
			vi.mocked(app.accountService.provisionCustomerAccount).mockRejectedValueOnce(
				new Error('CreateAccount failed')
			)

			const { result } = await paidDeposit()

			expect(result.outcome).toBe('applied')
			// The rejection is fire-and-forget (real account creation can take minutes, so it must
			// not hold up the webhook response) — give its .catch() a tick to settle so it does not
			// surface as an unhandled rejection after the test ends.
			await new Promise(resolve => setImmediate(resolve))
		})

		it('Is idempotent on the event id and on the session', async () => {
			const { result } = await paidDeposit()
			expect(result.outcome).toBe('applied')

			// Same event redelivered
			await expect(app.paymentService.handleWebhook('{}', 'sig')).resolves.toMatchObject({
				outcome: 'duplicate',
			})
			// A different event for the same (already paid) session
			vi.mocked(app.paymentProvider.constructWebhookEvent).mockReturnValueOnce(
				createMockPaymentEvent({ id: 'evt_2' })
			)
			await expect(app.paymentService.handleWebhook('{}', 'sig')).resolves.toMatchObject({
				outcome: 'duplicate',
			})
			expect(app.jobService.start).toHaveBeenCalledTimes(1)
		})

		it('Ignores other event types and unknown sessions', async () => {
			vi.mocked(app.paymentProvider.constructWebhookEvent).mockReturnValueOnce(
				createMockPaymentEvent({
					id: 'evt_3',
					type: 'payment_intent.created',
					sessionId: undefined,
				})
			)
			await expect(app.paymentService.handleWebhook('{}', 'sig')).resolves.toEqual({
				eventId: 'evt_3',
				outcome: 'ignored',
			})

			vi.mocked(app.paymentProvider.constructWebhookEvent).mockReturnValueOnce(
				createMockPaymentEvent({ id: 'evt_4', sessionId: 'cs_unknown' })
			)
			await expect(app.paymentService.handleWebhook('{}', 'sig')).resolves.toEqual({
				eventId: 'evt_4',
				outcome: 'duplicate',
				payment: undefined,
			})
		})

		it('Keeps the payment paid when the order cannot move on or the build cannot start', async () => {
			const order = await createOrder('frozen')
			await app.paymentService.checkout(order.id, 'deposit', user)
			vi.spyOn(app.jobService, 'start').mockRejectedValueOnce(new Error('ECS down'))

			const result = await app.paymentService.handleWebhook('{}', 'sig')

			expect(result.payment?.status).toBe('paid')
			await expect(app.orderService.get(order.id, user)).resolves.toMatchObject({
				status: 'deposit_paid',
			})

			// Order moved on meanwhile: the transition is rejected, the payment stays paid
			const second = await createOrder('frozen')
			const { payment } = await app.paymentService.checkout(second.id, 'deposit', user)
			vi.mocked(app.paymentProvider.constructWebhookEvent).mockReturnValueOnce(
				createMockPaymentEvent({ id: 'evt_9', sessionId: payment.sessionId })
			)
			vi.spyOn(app.orderService, 'transition').mockRejectedValueOnce(
				new InvalidOrderTransition(second.id, 'cancelled', 'deposit_paid')
			)
			await expect(app.paymentService.handleWebhook('{}', 'sig')).resolves.toMatchObject({
				outcome: 'applied',
				payment: { status: 'paid' },
			})
		})

		it('Forgets the event id when applying fails, so the retried delivery is processed', async () => {
			const order = await createOrder('frozen')
			await app.paymentService.checkout(order.id, 'deposit', user)
			vi.spyOn(app.db.orders, 'markPaymentPaid').mockRejectedValueOnce(new Error('pg down'))

			await expect(app.paymentService.handleWebhook('{}', 'sig')).rejects.toThrow('pg down')

			// Stripe redelivers the same evt_1: applied, not deduped
			await expect(app.paymentService.handleWebhook('{}', 'sig')).resolves.toMatchObject({
				outcome: 'applied',
				payment: { status: 'paid' },
			})
			await expect(app.orderService.get(order.id, user)).resolves.toMatchObject({
				status: 'building',
			})
		})

		it('Flags a refund when a second session of an already paid kind completes', async () => {
			const order = await createOrder('frozen')
			const first = await app.paymentService.checkout(order.id, 'deposit', user)
			const second = await app.paymentService.checkout(order.id, 'deposit', user)
			// Both sessions stayed payable (expire failed silently) and the customer paid both
			vi.mocked(app.paymentProvider.constructWebhookEvent)
				.mockReturnValueOnce(
					createMockPaymentEvent({ id: 'evt_a', sessionId: second.payment.sessionId })
				)
				.mockReturnValueOnce(
					createMockPaymentEvent({ id: 'evt_b', sessionId: first.payment.sessionId })
				)

			await expect(app.paymentService.handleWebhook('{}', 'sig')).resolves.toMatchObject({
				outcome: 'applied',
			})
			await expect(app.paymentService.handleWebhook('{}', 'sig')).resolves.toMatchObject({
				outcome: 'refund_due',
				payment: { id: first.payment.id, status: 'pending' },
			})

			expect(app.email.send).toHaveBeenCalledWith(
				expect.objectContaining({
					to: 'admin@example.com',
					subject: `Refund due: order ${order.id}`,
					text: expect.stringContaining(first.payment.sessionId),
				})
			)
			expect(app.jobService.start).toHaveBeenCalledTimes(1)
			// The event is done with: a redelivery is a duplicate, not another email
			vi.mocked(app.paymentProvider.constructWebhookEvent).mockReturnValueOnce(
				createMockPaymentEvent({ id: 'evt_b', sessionId: first.payment.sessionId })
			)
			await expect(app.paymentService.handleWebhook('{}', 'sig')).resolves.toMatchObject({
				outcome: 'duplicate',
			})
		})

		it('Flags a refund when the money arrives for an order cancelled meanwhile', async () => {
			const order = await createOrder('frozen')
			const { payment } = await app.paymentService.checkout(order.id, 'deposit', user)
			await app.orderService.cancel(order.id, user)

			const result = await app.paymentService.handleWebhook('{}', 'sig')

			expect(result).toMatchObject({
				outcome: 'refund_due',
				payment: { id: payment.id, status: 'paid' },
			})
			expect(app.email.send).toHaveBeenCalledWith(
				expect.objectContaining({ subject: `Refund due: order ${order.id}` })
			)
			expect(app.jobService.start).not.toHaveBeenCalled()
			await expect(app.orderService.get(order.id, user)).resolves.toMatchObject({
				status: 'cancelled',
			})
		})

		it('Applies async_payment_succeeded (delayed methods) like a paid completed session', async () => {
			const order = await createOrder('frozen')
			const { payment } = await app.paymentService.checkout(order.id, 'deposit', user)
			vi.mocked(app.paymentProvider.constructWebhookEvent).mockReturnValueOnce(
				createMockPaymentEvent({
					id: 'evt_async',
					type: 'checkout.session.async_payment_succeeded',
					sessionId: payment.sessionId,
				})
			)

			await expect(app.paymentService.handleWebhook('{}', 'sig')).resolves.toMatchObject({
				outcome: 'applied',
				payment: { status: 'paid' },
			})
			expect(app.jobService.start).toHaveBeenCalledTimes(1)
		})

		it('Keeps a paid deposit on an order an admin already started without one', async () => {
			const order = await createOrder('frozen')
			const { payment } = await app.paymentService.checkout(order.id, 'deposit', user)
			await app.orderService.transition(order.id, 'building')

			await expect(app.paymentService.handleWebhook('{}', 'sig')).resolves.toMatchObject({
				outcome: 'applied',
				payment: { id: payment.id, status: 'paid' },
			})
			expect(app.jobService.start).not.toHaveBeenCalled()
			await expect(app.orderService.get(order.id, user)).resolves.toMatchObject({
				status: 'building',
			})
		})

		it('Marks the balance paid and closes the order', async () => {
			const order = await createOrder('delivered')
			vi.spyOn(app.db.jobs, 'list').mockResolvedValue([
				createMockJob({ orderId: order.id, status: 'delivered' }),
			])
			const { payment } = await app.paymentService.checkout(order.id, 'balance', user)
			vi.mocked(app.paymentProvider.constructWebhookEvent).mockReturnValueOnce(
				createMockPaymentEvent({ id: 'evt_b', sessionId: payment.sessionId })
			)

			await app.paymentService.handleWebhook('{}', 'sig')

			await expect(app.orderService.get(order.id, user)).resolves.toMatchObject({ status: 'paid' })
			expect(app.jobService.start).not.toHaveBeenCalled()
		})

		it('Falls back to no receipt urls when Stripe cannot be reached', async () => {
			vi.mocked(app.paymentProvider.getSessionReceipts).mockRejectedValueOnce(new Error('down'))
			const { result } = await paidDeposit()
			expect(result.payment?.status).toBe('paid')
			expect(result.payment?.hostedInvoiceUrl).toBeUndefined()
			expect(result.payment?.receiptUrl).toBeUndefined()
		})
	})

	describe('completeFakeSession', () => {
		it('Rejects when Stripe is the active provider', async () => {
			await expect(app.paymentService.completeFakeSession('fake_x', user)).rejects.toBeInstanceOf(
				FakeProviderInactive
			)
		})

		it('Marks the fake session paid like a webhook would', async () => {
			// The real stripe plugin without a key decorates the fake provider
			vi.stubEnv('STRIPE_SECRET_KEY', '')
			vi.stubEnv('STRIPE_SECRET_KEY_SECRET_ARN', '')
			vi.doUnmock('#/plugins/stripe.ts')
			vi.resetModules()
			app = await createTestApp({
				skipMock: [
					'#/services/paymentService.ts',
					'#/services/orderService.ts',
					'#/plugins/stripe.ts',
				],
			})
			vi.spyOn(app.db.jobs, 'list').mockResolvedValue([])
			expect(app.paymentService.provider).toBe('fake')

			const order = await createOrder('frozen')
			const { payment, url } = await app.paymentService.checkout(order.id, 'deposit', user)
			expect(url).toBe(`https://api.example.com/bff/stripe/fake/checkout/${payment.sessionId}`)
			expect(payment.provider).toBe('fake')

			const paid = await app.paymentService.completeFakeSession(payment.sessionId, user)

			expect(paid).toMatchObject({ id: payment.id, status: 'paid' })
			expect(app.jobService.start).toHaveBeenCalledWith(order.id, expect.anything())
			await expect(app.orderService.get(order.id, user)).resolves.toMatchObject({
				status: 'building',
			})
			// Second visit of the same page: nothing happens, the paid payment is returned
			await expect(
				app.paymentService.completeFakeSession(payment.sessionId, user)
			).resolves.toMatchObject({ status: 'paid' })
			await expect(app.paymentService.completeFakeSession('fake_nope', user)).rejects.toThrow(
				/not found/
			)
			// Another org's session is as unknown as a missing one
			const theirs = await createOrder('frozen')
			const other = await app.paymentService.checkout(theirs.id, 'deposit', user)
			await expect(
				app.paymentService.completeFakeSession(other.payment.sessionId, { ...user, orgId: 'org-2' })
			).rejects.toThrow(/not found/)
			vi.unstubAllEnvs()
		})
	})

	describe('billResidentUsage', () => {
		const month = '2026-09'
		const record = (day: string, billableUsd: number, installationId = 'acme-shop') =>
			createMockResidentUsageRecord({
				installationId,
				day,
				month,
				cost: { listPriceUsd: billableUsd / 1.5, billableUsd },
			})

		/**
		 * The real resident service on top of the memory repositories. The outer `beforeEach`
		 * already mocked it for this file, so it is unmocked explicitly (`skipMock` only skips).
		 */
		const createBillingApp = async (skipMock: string[] = []) => {
			vi.doUnmock('#/services/residentService.ts')
			vi.resetModules()
			app = await createTestApp({
				skipMock: ['#/services/paymentService.ts', '#/services/residentService.ts', ...skipMock],
			})
			await app.residentService.recordUsage(record('2026-09-01', 6.75))
			await app.residentService.recordUsage(record('2026-09-02', 6.75))
			await app.residentService.recordUsage(record('2026-09-03', 1, 'beta-crm'))
			await app.residentService.upsertInstallation('acme-shop', { billingCustomerId: 'cus_acme' })
		}

		it('Reports each linked installation once and skips the ones without a customer', async () => {
			await createBillingApp()

			const run = await app.paymentService.billResidentUsage(month)

			expect(run).toEqual({
				month,
				provider: 'stripe',
				results: [
					{
						installationId: 'acme-shop',
						outcome: 'reported',
						usdCents: 1_350,
						totalUsdCents: 1_350,
					},
					{
						installationId: 'beta-crm',
						outcome: 'no_customer',
						usdCents: 0,
						totalUsdCents: 0,
						reason: expect.stringContaining('billing customer'),
					},
				],
			})
			expect(app.paymentProvider.reportUsage).toHaveBeenCalledTimes(1)
			expect(app.paymentProvider.reportUsage).toHaveBeenCalledWith({
				installationId: 'acme-shop',
				month,
				customerId: 'cus_acme',
				usdCents: 1_350,
				identifier: 'acme-shop/2026-09/1350',
			})
			await expect(app.db.resident.getUsageReport('acme-shop', month)).resolves.toMatchObject({
				usdCents: 1_350,
				provider: 'stripe',
				reference: 'mtr_acme-shop/2026-09/1350',
			})
		})

		it('Is idempotent: a re-run reports only what came in since, nothing when unchanged', async () => {
			await createBillingApp()
			await app.paymentService.billResidentUsage(month)

			const unchanged = await app.paymentService.billResidentUsage(month)
			await app.residentService.recordUsage(record('2026-09-04', 2))
			const delta = await app.paymentService.billResidentUsage(month)

			expect(unchanged.results[0]).toEqual({
				installationId: 'acme-shop',
				outcome: 'unchanged',
				usdCents: 0,
				totalUsdCents: 1_350,
			})
			expect(delta.results[0]).toEqual({
				installationId: 'acme-shop',
				outcome: 'reported',
				usdCents: 200,
				totalUsdCents: 1_550,
			})
			expect(app.paymentProvider.reportUsage).toHaveBeenLastCalledWith(
				expect.objectContaining({ usdCents: 200, identifier: 'acme-shop/2026-09/1550' })
			)
			// The summary now carries the report
			const [summary] = await app.residentService.summarizeUsage({ month })
			expect(summary?.report).toMatchObject({ usdCents: 1_550 })
		})

		it('Keeps the reported amount unchanged when the provider rejects the report', async () => {
			await createBillingApp()
			vi.spyOn(app.paymentProvider, 'reportUsage').mockRejectedValueOnce(new Error('rate limited'))

			const failed = await app.paymentService.billResidentUsage(month)

			expect(failed.results[0]).toMatchObject({
				outcome: 'failed',
				reason: 'rate limited',
				totalUsdCents: 0,
			})
			// The reservation records what was attempted; nothing counts as reported
			await expect(app.db.resident.getUsageReport('acme-shop', month)).resolves.toMatchObject({
				usdCents: 0,
				pendingUsdCents: 1_350,
				pendingIdentifier: 'acme-shop/2026-09/1350',
			})
			// The next run reports the full amount
			const retry = await app.paymentService.billResidentUsage(month)
			expect(retry.results[0]).toMatchObject({ outcome: 'reported', usdCents: 1_350 })
			const report = await app.db.resident.getUsageReport('acme-shop', month)
			expect(report).toMatchObject({ usdCents: 1_350, reference: 'mtr_acme-shop/2026-09/1350' })
			expect(report?.pendingUsdCents).toBeUndefined()
			expect(report?.pendingAt).toBeUndefined()
		})

		it('Retries the identical event when the row could not be confirmed, even after new usage', async () => {
			// Stripe accepted the event but the confirm write failed: the money side moved, the
			// ledger did not. The retry must send the same identifier (deduped at Stripe), not a
			// fresh delta that would bill the 1 350 cents again.
			await createBillingApp()
			vi.spyOn(app.db.resident, 'confirmUsageReport').mockRejectedValueOnce(new Error('pg blip'))

			const failed = await app.paymentService.billResidentUsage(month)
			await app.residentService.recordUsage(record('2026-09-04', 2))
			const retry = await app.paymentService.billResidentUsage(month)
			const rest = await app.paymentService.billResidentUsage(month)

			expect(failed.results[0]).toMatchObject({ outcome: 'failed', reason: 'pg blip' })
			expect(retry.results[0]).toEqual({
				installationId: 'acme-shop',
				outcome: 'reported',
				usdCents: 1_350,
				totalUsdCents: 1_350,
			})
			expect(app.paymentProvider.reportUsage).toHaveBeenNthCalledWith(
				2,
				expect.objectContaining({ usdCents: 1_350, identifier: 'acme-shop/2026-09/1350' })
			)
			// The day that arrived meanwhile is billed by the run after
			expect(rest.results[0]).toMatchObject({ outcome: 'reported', usdCents: 200 })
			expect(app.paymentProvider.reportUsage).toHaveBeenCalledTimes(3)
		})

		it('Retries a report left in flight by a run that died, once it has timed out', async () => {
			await createBillingApp()
			vi.useFakeTimers({ toFake: ['Date'] })
			vi.spyOn(app.db.resident, 'confirmUsageReport').mockRejectedValueOnce(new Error('pg gone'))
			vi.spyOn(app.db.resident, 'releaseUsageReport').mockRejectedValueOnce(new Error('pg gone'))

			const died = await app.paymentService.billResidentUsage(month)
			const tooSoon = await app.paymentService.billResidentUsage(month)
			vi.advanceTimersByTime(usageReportInFlightMs + 1)
			const retried = await app.paymentService.billResidentUsage(month)
			vi.useRealTimers()

			expect(died.results[0]).toMatchObject({ outcome: 'failed', reason: 'pg gone' })
			expect(tooSoon.results[0]).toMatchObject({ outcome: 'in_progress' })
			expect(retried.results[0]).toMatchObject({ outcome: 'reported', usdCents: 1_350 })
			expect(app.paymentProvider.reportUsage).toHaveBeenCalledTimes(2)
			expect(app.paymentProvider.reportUsage).toHaveBeenLastCalledWith(
				expect.objectContaining({ identifier: 'acme-shop/2026-09/1350' })
			)
		})

		it('Lets a concurrent run lose the reservation instead of reporting twice', async () => {
			await createBillingApp()
			// Run A is at the provider when run B reads the same (empty) report
			let releaseA: () => void = () => {}
			vi.spyOn(app.paymentProvider, 'reportUsage').mockImplementationOnce(
				input =>
					new Promise(resolve => {
						releaseA = () => resolve({ reference: `mtr_${input.identifier}` })
					})
			)

			const runA = app.paymentService.billResidentUsage(month)
			await vi.waitFor(() => expect(app.paymentProvider.reportUsage).toHaveBeenCalledTimes(1))
			await app.residentService.recordUsage(record('2026-09-04', 2))
			const runB = await app.paymentService.billResidentUsage(month)
			releaseA()
			const resultA = await runA

			expect(runB.results[0]).toMatchObject({
				outcome: 'in_progress',
				usdCents: 0,
				reason: expect.stringContaining('in flight'),
			})
			expect(resultA.results[0]).toMatchObject({ outcome: 'reported', usdCents: 1_350 })
			expect(app.paymentProvider.reportUsage).toHaveBeenCalledTimes(1)
			// The next run picks up what B saw
			const runC = await app.paymentService.billResidentUsage(month)
			expect(runC.results[0]).toMatchObject({ outcome: 'reported', usdCents: 200 })
		})

		it('Flags a month whose total dropped below what was reported, with the credit due', async () => {
			await createBillingApp()
			await app.paymentService.billResidentUsage(month)
			// A metering correction re-sends day 3 lower (last write wins)
			await app.residentService.recordUsage(record('2026-09-02', 6.25))

			const run = await app.paymentService.billResidentUsage(month)

			expect(run.results[0]).toEqual({
				installationId: 'acme-shop',
				outcome: 'overreported',
				usdCents: 0,
				totalUsdCents: 1_350,
				reason: expect.stringContaining('credit 50 cents'),
			})
			expect(app.paymentProvider.reportUsage).toHaveBeenCalledTimes(1)
		})

		it("Does not count another provider's reports: the fake one's months go to Stripe", async () => {
			await createBillingApp()
			await app.db.resident.upsertUsageReport({
				installationId: 'acme-shop',
				month,
				usdCents: 1_350,
				provider: 'fake',
				reference: 'fake_usage_acme-shop/2026-09/1350',
			})

			const run = await app.paymentService.billResidentUsage(month)

			expect(run.results[0]).toMatchObject({
				outcome: 'reported',
				usdCents: 1_350,
				totalUsdCents: 1_350,
			})
			await expect(app.db.resident.getUsageReport('acme-shop', month)).resolves.toMatchObject({
				provider: 'stripe',
				usdCents: 1_350,
				reference: 'mtr_acme-shop/2026-09/1350',
			})
		})

		it("Keeps the identifier within the provider's limit for a long installation id", async () => {
			const longId =
				'customer-name-eu-north-1-prod-repo-owner-repo-name-resident-agent-installation-2026-primary'
			await createBillingApp()
			await app.residentService.recordUsage(record('2026-09-01', 6.75, longId))
			await app.residentService.upsertInstallation(longId, { billingCustomerId: 'cus_long' })

			const run = await app.paymentService.billResidentUsage(month)
			const identifier = usageReportIdentifier(longId, month, 675)

			expect(identifier.length).toBeLessThanOrEqual(maxUsageIdentifierLength)
			expect(identifier).toMatch(/^[0-9a-f]{32}\/2026-09\/675$/)
			expect(usageReportIdentifier('acme-shop', month, 675)).toBe('acme-shop/2026-09/675')
			expect(run.results.find(result => result.installationId === longId)).toMatchObject({
				outcome: 'reported',
				usdCents: 675,
			})
			expect(app.paymentProvider.reportUsage).toHaveBeenCalledWith(
				expect.objectContaining({ installationId: longId, identifier })
			)
		})

		it('Records the report on the fake provider without needing a customer id', async () => {
			vi.stubEnv('STRIPE_SECRET_KEY', '')
			vi.stubEnv('STRIPE_SECRET_KEY_SECRET_ARN', '')
			vi.doUnmock('#/plugins/stripe.ts')
			vi.resetModules()
			await createBillingApp(['#/plugins/stripe.ts'])

			const run = await app.paymentService.billResidentUsage(month)

			expect(run.provider).toBe('fake')
			expect(run.results.map(result => [result.installationId, result.outcome])).toEqual([
				['acme-shop', 'reported'],
				['beta-crm', 'reported'],
			])
			expect((app.paymentProvider as FakePaymentProvider).usageReports).toMatchObject([
				{ installationId: 'acme-shop', usdCents: 1_350 },
				{ installationId: 'beta-crm', usdCents: 100 },
			])
			await expect(app.db.resident.getUsageReport('beta-crm', month)).resolves.toMatchObject({
				provider: 'fake',
				reference: 'fake_usage_beta-crm/2026-09/100',
			})
			vi.unstubAllEnvs()
		})
	})
})

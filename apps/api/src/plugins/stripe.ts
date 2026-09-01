import fp from 'fastify-plugin'
import Stripe from 'stripe'
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'

import { parseSecretString } from '#/plugins/secrets.ts'

import type { FastifyPluginAsync } from 'fastify'
import type { PaymentKind, PaymentProvider as PaymentProviderKind } from '@mf/models'

export type CheckoutInput = {
	paymentId: string
	orderId: string
	orderName: string
	kind: PaymentKind
	/**
	 * Share of the order price this payment covers (`paymentShareFor`): 0.5 on the 50/50 split,
	 * 1 for a full-upfront order — it decides the line-item label on the Checkout page
	 */
	share: number
	/** Net amount in SEK ex moms — shown as its own line item */
	amountSek: number
	/** 25 % moms — shown as a separate line item */
	vatSek: number
	customerEmail?: string
	successUrl: string
	cancelUrl: string
}

export type CheckoutSession = { sessionId: string; url: string }

/** A provider-neutral view of the webhook events the payment service acts on */
export type PaymentEvent = {
	id: string
	type: string
	/**
	 * Set only when the event means the session's money is in: `checkout.session.completed`
	 * with `payment_status: 'paid'`, or `checkout.session.async_payment_succeeded` (delayed
	 * methods complete the session first and confirm the funds later).
	 */
	sessionId?: string
}

export type SessionReceipts = { hostedInvoiceUrl?: string; receiptUrl?: string }

/** One usage report for the resident's metered subscription (M8 usage-based billing) */
export type UsageReportInput = {
	installationId: string
	month: string
	/** The provider's customer id (Stripe `cus_…`); required by the Stripe provider */
	customerId?: string
	/** Billable US cents to add for the month (a delta, not the month's total) */
	usdCents: number
	/** Unique per report: the provider deduplicates retries on it */
	identifier: string
}

export type UsageReport = { reference: string }

export type PaymentProvider = {
	kind: PaymentProviderKind
	createCheckoutSession: (input: CheckoutInput) => Promise<CheckoutSession>
	/** Verifies the signature and parses the raw webhook body; throws when invalid */
	constructWebhookEvent: (rawBody: string, signature: string | undefined) => PaymentEvent
	/** Stripe-hosted invoice / receipt urls once the session has completed */
	getSessionReceipts: (sessionId: string) => Promise<SessionReceipts>
	/** Closes an open Checkout session so it can no longer be paid (no-op when already closed) */
	expireSession: (sessionId: string) => Promise<void>
	/**
	 * Reports metered usage for a customer's subscription; the returned reference identifies
	 * the report at the provider. Throws `UsageNotBillable` when the customer id is missing.
	 */
	reportUsage: (input: UsageReportInput) => Promise<UsageReport>
}

/** The fake provider keeps every usage report it "sends" so tests and dev can inspect them */
export type FakePaymentProvider = PaymentProvider & { usageReports: UsageReportInput[] }

/** The installation has no provider customer to bill (Stripe needs a `cus_…` id) */
export class UsageNotBillable extends Error {
	constructor(installationId: string) {
		super(`Installation ${installationId} has no billing customer id`)
	}
}

declare module 'fastify' {
	interface FastifyInstance {
		/**
		 * Payment provider behind Checkout: Stripe when `STRIPE_SECRET_KEY` (or the Secrets
		 * Manager secret) is set, otherwise the clearly-labelled `fake` provider whose checkout
		 * url is a local api route that marks the payment paid at once — dev/test only.
		 */
		paymentProvider: PaymentProvider
	}
}

export class InvalidWebhookSignature extends Error {
	constructor(cause: unknown) {
		super(`Invalid webhook signature: ${(cause as Error)?.message ?? String(cause)}`, { cause })
	}
}

export const fakeSessionPrefix = 'fake_'

/** Path of the fake provider's checkout page (see routes/bff/stripe/fakeCheckout.ts) */
export const fakeCheckoutPath = (sessionId: string) => `/bff/stripe/fake/checkout/${sessionId}`

/**
 * Line-item label on the Stripe Checkout page and the hosted invoice/receipt it produces.
 * A full-upfront payment (share 1, order below the 3 000 kr threshold) covers the whole price
 * and must say so — labelling it "Deposit 50 %" would misstate the charge on the customer's
 * payment documents. The 50/50 split keeps the kind-specific labels.
 */
const lineItemLabel = (kind: PaymentKind, share: number): string => {
	if (share === 1) return 'Betalning 100 % / Payment 100 %'
	return kind === 'deposit' ? 'Handpenning 50 % / Deposit 50 %' : 'Slutbetalning 50 % / Balance 50 %'
}

// MARK: Providers

/** Envs where the fake provider accepts unsigned webhook bodies (never a deployed env) */
export const unsignedWebhookEnvs = new Set(['local', 'test'])

export const createFakeProvider = (apiUrl: string, env: string): FakePaymentProvider => ({
	kind: 'fake',
	usageReports: [],
	createCheckoutSession: async input => {
		const sessionId = `${fakeSessionPrefix}${input.paymentId}`
		return { sessionId, url: `${apiUrl}${fakeCheckoutPath(sessionId)}` }
	},
	// No signature to verify: the body is the event itself. Only on a developer's machine —
	// in a deployed env the public webhook route would otherwise take anyone's events.
	constructWebhookEvent: rawBody => {
		if (!unsignedWebhookEnvs.has(env)) {
			throw new InvalidWebhookSignature(`fake provider takes no webhooks in env ${env}`)
		}
		const event = JSON.parse(rawBody) as Partial<PaymentEvent>
		if (typeof event.id !== 'string' || typeof event.type !== 'string') {
			throw new InvalidWebhookSignature('fake event needs id and type')
		}
		return { id: event.id, type: event.type, sessionId: event.sessionId }
	},
	getSessionReceipts: async () => ({}),
	expireSession: async () => {},
	// No customer needed: the report is recorded locally, nothing is billed
	async reportUsage(input) {
		this.usageReports.push(structuredClone(input))
		return { reference: `fake_usage_${input.identifier}` }
	},
})

/**
 * The session id when the event means the money is in. `checkout.session.completed` also
 * fires with `payment_status: 'unpaid'` for delayed-notification methods (bank transfer etc.);
 * those sessions are paid only on `checkout.session.async_payment_succeeded`.
 */
export const sessionIdOf = (event: Stripe.Event) => {
	if (event.type === 'checkout.session.async_payment_succeeded') return event.data.object.id
	if (event.type === 'checkout.session.completed' && event.data.object.payment_status === 'paid') {
		return event.data.object.id
	}
	return undefined
}

export type StripeProviderOptions = {
	webhookSecret?: string
	/** Billing meter `event_name` the usage cents are reported under */
	meterEvent: string
}

/**
 * Stripe requires an eligible product tax code on every line item to offer Klarna/BNPL —
 * checkout.sessions.create rejects with "the product tax code is missing" otherwise. "General
 * - Electronically Supplied Services" is a safe, eligible default for our delivered software;
 * refine with tax advice if we ever adopt Stripe Tax.
 */
const PRODUCT_TAX_CODE = 'txcd_10000000'

export const createStripeProvider = (
	stripe: Stripe,
	options: StripeProviderOptions
): PaymentProvider => ({
	kind: 'stripe',
	createCheckoutSession: async input => {
		const session = await stripe.checkout.sessions.create({
			mode: 'payment',
			billing_address_collection: 'required',
			currency: 'sek',
			// We are the merchant of record (VAT is itemized and remitted by us), so opt each session
			// out of Stripe Managed Payments and offer the methods explicitly — this is what surfaces
			// Klarna (Managed Payments wouldn't offer it on the unactivated account).
			managed_payments: { enabled: false },
			payment_method_types: ['card', 'klarna'],
			line_items: [
				{
					quantity: 1,
					price_data: {
						currency: 'sek',
						unit_amount: input.amountSek * 100,
						product_data: {
							name: `${input.orderName} — ${lineItemLabel(input.kind, input.share)}`,
							tax_code: PRODUCT_TAX_CODE,
						},
					},
				},
				{
					quantity: 1,
					price_data: {
						currency: 'sek',
						unit_amount: input.vatSek * 100,
						product_data: { name: 'Moms 25 % / VAT 25 %', tax_code: PRODUCT_TAX_CODE },
					},
				},
			],
			client_reference_id: input.paymentId,
			metadata: { orderId: input.orderId, paymentId: input.paymentId, kind: input.kind },
			customer_email: input.customerEmail,
			invoice_creation: { enabled: true },
			success_url: input.successUrl,
			cancel_url: input.cancelUrl,
		})
		if (!session.url) throw new Error('Stripe returned a Checkout session without url')
		return { sessionId: session.id, url: session.url }
	},
	constructWebhookEvent: (rawBody, signature) => {
		const { webhookSecret } = options
		if (!webhookSecret) throw new InvalidWebhookSignature('STRIPE_WEBHOOK_SECRET is not set')
		if (!signature) throw new InvalidWebhookSignature('missing stripe-signature header')
		try {
			const event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret)
			return { id: event.id, type: event.type, sessionId: sessionIdOf(event) }
		} catch (error) {
			throw new InvalidWebhookSignature(error)
		}
	},
	getSessionReceipts: async sessionId => {
		const session = await stripe.checkout.sessions.retrieve(sessionId, {
			expand: ['invoice', 'payment_intent.latest_charge'],
		})
		const invoice = session.invoice as Stripe.Invoice | null
		const intent = session.payment_intent as Stripe.PaymentIntent | null
		const charge = intent?.latest_charge as Stripe.Charge | null | undefined
		return {
			hostedInvoiceUrl: invoice?.hosted_invoice_url ?? undefined,
			receiptUrl: charge?.receipt_url ?? undefined,
		}
	},
	expireSession: async sessionId => {
		const session = await stripe.checkout.sessions.retrieve(sessionId)
		if (session.status === 'open') await stripe.checkout.sessions.expire(sessionId)
	},
	// Billing Meters: one event per report, `value` in US cents; the metered price attached
	// to the meter turns the month's events into the invoice line. `identifier` makes a
	// retried report a no-op at Stripe (unique within 24 h).
	reportUsage: async input => {
		if (!input.customerId) throw new UsageNotBillable(input.installationId)
		const event = await stripe.billing.meterEvents.create({
			event_name: options.meterEvent,
			identifier: input.identifier,
			payload: { stripe_customer_id: input.customerId, value: String(input.usdCents) },
		})
		return { reference: event.identifier }
	},
})

// MARK: Plugin

const plugin: FastifyPluginAsync = async app => {
	const { secrets } = app

	const resolveSecret = async (envName: string, arn: string | undefined) => {
		const fromEnv = process.env[envName]?.trim()
		if (fromEnv) return fromEnv
		if (!arn) return undefined
		const client = new SecretsManagerClient({})
		try {
			const result = await client.send(new GetSecretValueCommand({ SecretId: arn }))
			const value = parseSecretString(result.SecretString)
			if (!value) app.log.warn({ arn }, `${envName}: secret is an empty placeholder`)
			return value
		} catch (error) {
			app.log.warn({ err: error, arn }, `${envName}: could not resolve secret from Secrets Manager`)
			return undefined
		} finally {
			client.destroy()
		}
	}

	// The CDK placeholder for these secrets is a random 32-char string (README "Secrets") — never
	// empty, so a plain `!secretKey` check can't tell "not yet filled in" from "a real key". Shape-
	// checking the Stripe prefix closes that hole (hardening audit 2026-08-30, finding E1): an
	// un-filled `live` secret now hits the same `required in live` throw as a genuinely missing one,
	// instead of silently booting the real Stripe client on 32 junk characters.
	const rawSecretKey = await resolveSecret(
		'STRIPE_SECRET_KEY',
		secrets.infra.stripeSecretKeySecretArn
	)
	const secretKey = rawSecretKey && /^sk_(test|live)_/.test(rawSecretKey) ? rawSecretKey : undefined
	if (!secretKey) {
		if (secrets.env === 'live') throw new Error('STRIPE_SECRET_KEY is required in live')
		if (rawSecretKey) app.log.warn('STRIPE_SECRET_KEY does not look like a Stripe key — ignoring it')
		app.log.warn(
			'STRIPE_SECRET_KEY not set — using the FAKE payment provider: checkout marks payments paid immediately, no money moves'
		)
		app.decorate('paymentProvider', createFakeProvider(secrets.authIssuer, secrets.env))
		return
	}

	const rawWebhookSecret = await resolveSecret(
		'STRIPE_WEBHOOK_SECRET',
		secrets.infra.stripeWebhookSecretSecretArn
	)
	const webhookSecret =
		rawWebhookSecret && rawWebhookSecret.startsWith('whsec_') ? rawWebhookSecret : undefined
	if (!webhookSecret) {
		app.log.warn(
			rawWebhookSecret
				? 'STRIPE_WEBHOOK_SECRET does not look like a Stripe webhook secret — ignoring it, webhooks will be rejected'
				: 'STRIPE_WEBHOOK_SECRET not set — webhooks will be rejected'
		)
	}
	// fetch client: one HTTP path for Node ≥ 18 (and interceptable by the test network mock)
	const stripe = new Stripe(secretKey, {
		maxNetworkRetries: 2,
		timeout: 20_000,
		httpClient: Stripe.createFetchHttpClient(),
	})
	app.log.info(`Payments: Stripe (${secretKey.startsWith('sk_live') ? 'live' : 'test'} mode)`)
	app.decorate(
		'paymentProvider',
		createStripeProvider(stripe, { webhookSecret, meterEvent: secrets.residentBilling.meterEvent })
	)
}

export default fp(plugin, { name: '#internal/stripe', dependencies: ['#internal/secrets'] })

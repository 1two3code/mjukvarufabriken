import { z } from 'zod'

// MARK: Enums
/** Deposit: 50 % before the build starts; balance: the remaining 50 % on delivery */
export const paymentKind = ['deposit', 'balance'] as const
export type PaymentKind = (typeof paymentKind)[number]

export const paymentStatus = ['pending', 'paid'] as const
export type PaymentStatus = (typeof paymentStatus)[number]

/** `fake` is the local provider used when no Stripe key is configured (dev/test only) */
export const paymentProvider = ['stripe', 'fake'] as const
export type PaymentProvider = (typeof paymentProvider)[number]

/** Swedish VAT on services */
export const vatRate = 0.25

/** Share of the fixed price charged at each step */
export const paymentShare: Record<PaymentKind, number> = { deposit: 0.5, balance: 0.5 }

/** Amounts in whole SEK for one payment of an order priced `priceSek` ex moms */
export const paymentAmounts = (priceSek: number, kind: PaymentKind) => {
	const amountSek = Math.round(priceSek * paymentShare[kind])
	const vatSek = Math.round(amountSek * vatRate)
	return { amountSek, vatSek, totalSek: amountSek + vatSek }
}

// MARK: Payment
export const PaymentSchema = z.object({
	id: z.string(),
	orderId: z.string(),
	kind: z.enum(paymentKind),
	status: z.enum(paymentStatus),
	provider: z.enum(paymentProvider),
	/** Net amount in SEK ex moms */
	amountSek: z.number().int().nonnegative(),
	/** 25 % moms, shown separately on the Checkout page */
	vatSek: z.number().int().nonnegative(),
	totalSek: z.number().int().nonnegative(),
	/** Checkout session id (Stripe `cs_…`, or `fake_…`) */
	sessionId: z.string(),
	/** Webhook event id that marked the payment paid (idempotency) */
	eventId: z.string().optional(),
	/** Stripe-hosted invoice / receipt, stored when the session completes */
	hostedInvoiceUrl: z.string().optional(),
	receiptUrl: z.string().optional(),
	paidAt: z.iso.datetime().optional(),
	createdAt: z.iso.datetime(),
})
export type Payment = z.infer<typeof PaymentSchema>

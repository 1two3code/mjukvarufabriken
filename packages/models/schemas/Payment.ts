import { z } from 'zod'

// MARK: Enums
/**
 * Deposit: the payment before the build starts (50 % of the price, or 100 % for an order below
 * the full-upfront threshold); balance: the remainder on delivery (absent for full-upfront orders)
 */
export const paymentKind = ['deposit', 'balance'] as const
export type PaymentKind = (typeof paymentKind)[number]

export const paymentStatus = ['pending', 'paid'] as const
export type PaymentStatus = (typeof paymentStatus)[number]

/** `fake` is the local provider used when no Stripe key is configured (dev/test only) */
export const paymentProvider = ['stripe', 'fake'] as const
export type PaymentProvider = (typeof paymentProvider)[number]

/** Swedish VAT on services */
export const vatRate = 0.25

/**
 * Orders priced below this are paid in full upfront: one Checkout for the whole price before the
 * build starts, and no balance payment on delivery (pricing ladder decision 2026-08-31 — a 50/50
 * split on a 500 kr demo build is pointless friction). At or above the threshold the classic
 * 50 % deposit / 50 % balance split applies.
 */
export const fullUpfrontBelowSek = 3_000

/** True when an order of this price is paid in full upfront (no balance payment exists) */
export const isFullUpfront = (priceSek: number) => priceSek < fullUpfrontBelowSek

/** Share of the fixed price charged at each step for an order paying the 50/50 split */
export const paymentShare: Record<PaymentKind, number> = { deposit: 0.5, balance: 0.5 }

/** Share of the fixed price charged at each step for an order priced `priceSek` */
export const paymentShareFor = (priceSek: number, kind: PaymentKind): number => {
	if (!isFullUpfront(priceSek)) return paymentShare[kind]
	return kind === 'deposit' ? 1 : 0
}

/**
 * The payment kinds an order of this price goes through: just the upfront payment (stored as the
 * `deposit`, covering 100 %) below the full-upfront threshold, deposit + balance above.
 */
export const requiredPaymentKinds = (priceSek: number): readonly PaymentKind[] =>
	isFullUpfront(priceSek) ? ['deposit'] : ['deposit', 'balance']

/** Amounts in whole SEK for one payment of an order priced `priceSek` ex moms */
export const paymentAmounts = (priceSek: number, kind: PaymentKind) => {
	const amountSek = Math.round(priceSek * paymentShareFor(priceSek, kind))
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

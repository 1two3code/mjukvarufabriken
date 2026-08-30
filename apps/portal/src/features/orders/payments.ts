import type { Payment, PaymentKind } from '@mf/models'

/**
 * The latest payment of a kind in a status. A paid session wins over a pending one on the
 * panel (the caller asks for `paid` first), so an abandoned Checkout followed by a completed
 * one shows as paid, not as "started, not completed".
 */
export const paymentOf = (payments: Payment[], kind: PaymentKind, status: Payment['status']) =>
	payments.findLast(payment => payment.kind === kind && payment.status === status)

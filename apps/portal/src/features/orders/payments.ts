import type { OrderDetail, Payment, PaymentKind } from '@mf/models'

/**
 * The balance is not due while the delivered app's preview is not working (Hasse, 2026-09-03):
 * the order is delivered — repo and handover honoured — but the preview URL was withheld. The
 * api refuses the checkout (`balanceAwaitsPreview`); the panel explains instead of offering it.
 */
export const balanceAwaitsPreview = (detail: OrderDetail) =>
	detail.order.status === 'delivered' && detail.hosting.status === 'unhosted'

/**
 * The latest payment of a kind in a status. A paid session wins over a pending one on the
 * panel (the caller asks for `paid` first), so an abandoned Checkout followed by a completed
 * one shows as paid, not as "started, not completed".
 */
export const paymentOf = (payments: Payment[], kind: PaymentKind, status: Payment['status']) =>
	payments.findLast(payment => payment.kind === kind && payment.status === status)

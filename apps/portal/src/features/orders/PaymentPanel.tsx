import styles from './PaymentPanel.module.css'

import { useTranslation } from 'react-i18next'
import { paymentAmounts } from '@mf/models'

import { useCreateCheckoutMutation } from '#/features/orders/ordersApiSlice.ts'

import { Button } from '#/components/Button.tsx'

import type { OrderDetail, Payment, PaymentKind } from '@mf/models'

type PaymentPanelProps = {
	detail: OrderDetail
}

/** Which payment is due in which order status */
const dueIn: Record<PaymentKind, OrderDetail['order']['status']> = {
	deposit: 'frozen',
	balance: 'delivered',
}

type PaymentRowProps = {
	kind: PaymentKind
	priceSek: number
	paid?: Payment
	due: boolean
	orderId: string
}

function PaymentRow({ kind, priceSek, paid, due, orderId }: PaymentRowProps) {
	const { t, i18n } = useTranslation()
	const [createCheckout, { isLoading }] = useCreateCheckoutMutation()
	const amounts = paid ?? paymentAmounts(priceSek, kind)
	const format = (value: number) => value.toLocaleString(i18n.language)

	const handlePay = async () => {
		const result = await createCheckout({ orderId, kind })
		// Stripe Checkout (or the fake provider's local page) takes over the browser from here
		if (!result.error) window.location.assign(result.data.url)
	}

	return (
		<li className={[styles.row, paid ? styles.paid : ''].join(' ')}>
			<div className={styles.rowHeader}>
				<span className={styles.kind}>{t(`payment.kind.${kind}`)}</span>
				<span className={styles.state}>
					{paid
						? t('payment.paidAt', {
								date: paid.paidAt ? new Date(paid.paidAt).toLocaleDateString(i18n.language) : '',
							})
						: due
							? t('payment.due')
							: t('payment.notYet')}
				</span>
			</div>
			<dl className={styles.amounts}>
				<dt>{t('payment.amount')}</dt>
				<dd className={styles.value}>
					{t('order.priceValue', { price: format(amounts.amountSek) })}
				</dd>
				<dt>{t('payment.vat')}</dt>
				<dd className={styles.value}>{t('order.priceValue', { price: format(amounts.vatSek) })}</dd>
				<dt className={styles.total}>{t('payment.total')}</dt>
				<dd className={[styles.value, styles.total].join(' ')}>
					{t('order.priceValue', { price: format(amounts.totalSek) })}
				</dd>
			</dl>
			{paid && (paid.hostedInvoiceUrl || paid.receiptUrl) && (
				<div className={styles.links}>
					{paid.hostedInvoiceUrl && (
						<a href={paid.hostedInvoiceUrl} target="_blank" rel="noreferrer">
							{t('payment.action.invoice')}
						</a>
					)}
					{paid.receiptUrl && (
						<a href={paid.receiptUrl} target="_blank" rel="noreferrer">
							{t('payment.action.receipt')}
						</a>
					)}
				</div>
			)}
			{paid?.provider === 'fake' && <p className={styles.fake}>{t('payment.fakeNotice')}</p>}
			{due && !paid && (
				<div className={styles.actions}>
					<Button disabled={isLoading} onClick={handlePay}>
						{t(`payment.action.pay.${kind}`)}
					</Button>
				</div>
			)}
		</li>
	)
}

/** Deposit + balance with Stripe-hosted invoice/receipt links; the due one has a pay button */
export function PaymentPanel({ detail }: PaymentPanelProps) {
	const { t } = useTranslation()
	const { order, payments } = detail
	if (order.priceSek === undefined) return null

	const paidOf = (kind: PaymentKind) =>
		payments.find(payment => payment.kind === kind && payment.status === 'paid')

	return (
		<section className={styles.panel}>
			<h2 className={styles.title}>{t('payment.title')}</h2>
			<p className={styles.intro}>{t('payment.intro')}</p>
			<ul className={styles.list}>
				{(['deposit', 'balance'] as const).map(kind => (
					<PaymentRow
						key={kind}
						kind={kind}
						priceSek={order.priceSek!}
						paid={paidOf(kind)}
						due={order.status === dueIn[kind]}
						orderId={order.id}
					/>
				))}
			</ul>
		</section>
	)
}

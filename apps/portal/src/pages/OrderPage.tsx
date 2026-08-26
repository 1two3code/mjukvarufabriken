import styles from './OrderPage.module.css'

import { useTranslation } from 'react-i18next'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { isActiveJobStatus } from '@mf/models'

import { useCancelOrderMutation, useGetOrderQuery } from '#/features/orders/ordersApiSlice.ts'
import { OrderStatusBadge } from '#/features/orders/OrderStatusBadge.tsx'
import { OrderStepper } from '#/features/orders/OrderStepper.tsx'
import { PaymentPanel } from '#/features/orders/PaymentPanel.tsx'

import { Button } from '#/components/Button.tsx'
import { Spinner } from '#/components/Spinner.tsx'

import type { OrderDetail } from '@mf/models'

const pollingInterval = 5000

/** What the customer should do next, per status */
const nextStep = (detail: OrderDetail) => {
	const { order, spec } = detail
	switch (order.status) {
		case 'drafting':
			return spec.complete ? 'freeze' : 'spec'
		case 'ready':
			return 'freeze'
		case 'frozen':
			return 'deposit'
		case 'deposit_paid':
			return 'starting'
		case 'building':
			return 'building'
		case 'delivered':
			return 'balance'
		case 'paid':
			return 'done'
		case 'cancelled':
			return 'cancelled'
	}
}

const cancellable = new Set<OrderDetail['order']['status']>([
	'drafting',
	'ready',
	'frozen',
	'deposit_paid',
	'building',
])

export function OrderPage() {
	const { t, i18n } = useTranslation()
	const { orderId = '' } = useParams()
	const [searchParams] = useSearchParams()
	const {
		data: detail,
		isLoading,
		isError,
	} = useGetOrderQuery(orderId, {
		skip: !orderId,
		// A payment or a build in flight: keep the page fresh without a manual reload
		pollingInterval: pollingInterval,
	})
	const [cancel, { isLoading: isCancelling }] = useCancelOrderMutation()

	if (isLoading) return <Spinner center />
	if (isError || !detail) return <p className={styles.error}>{t('order.page.loadError')}</p>

	const { order, latestJob, spec } = detail
	const paymentResult = searchParams.get('payment')
	const buildActive = latestJob ? isActiveJobStatus(latestJob.status) : false

	return (
		<>
			<div className={styles.heading}>
				<h1 className={styles.title}>{order.name || t('order.page.untitled')}</h1>
				<OrderStatusBadge status={order.status} />
			</div>
			<p className={styles.intro}>
				<Link to="/orders">{t('order.page.backToOrders')}</Link>
			</p>

			{paymentResult === 'success' && (
				<p className={[styles.banner, styles.success].join(' ')}>
					{t('order.page.paymentSuccess')}
					{searchParams.get('fake') && ` ${t('payment.fakeNotice')}`}
				</p>
			)}
			{paymentResult === 'cancelled' && (
				<p className={[styles.banner, styles.caution].join(' ')}>
					{t('order.page.paymentCancelled')}
				</p>
			)}

			<OrderStepper status={order.status} />

			<div className={styles.layout}>
				<section className={styles.next}>
					<h2 className={styles.sectionTitle}>{t('order.page.nextTitle')}</h2>
					<p className={styles.nextBody}>{t(`order.next.${nextStep(detail)}`)}</p>
					<div className={styles.actions}>
						<Link to={`/orders/${order.id}/spec`}>
							{t(spec.status === 'frozen' ? 'order.action.viewSpec' : 'order.action.editSpec')}
						</Link>
						{latestJob && (
							<Link to={`/orders/${order.id}/job`}>
								{t(buildActive ? 'order.action.followBuild' : 'order.action.viewBuild')}
							</Link>
						)}
					</div>

					<dl className={styles.facts}>
						<dt className={styles.label}>{t('order.field.price')}</dt>
						<dd className={styles.value}>
							{order.priceSek === undefined
								? t('order.page.priceNotYet')
								: t('order.priceValue', { price: order.priceSek.toLocaleString(i18n.language) })}
						</dd>
						{order.sizeClass && (
							<>
								<dt className={styles.label}>{t('order.field.sizeClass')}</dt>
								<dd className={styles.value}>{order.sizeClass}</dd>
							</>
						)}
						<dt className={styles.label}>{t('order.field.spec')}</dt>
						<dd className={styles.value}>
							{t(`spec.status.${spec.status}`)}
							{spec.openQuestions > 0 &&
								` · ${t('order.page.openQuestions', { count: spec.openQuestions })}`}
						</dd>
						{latestJob && (
							<>
								<dt className={styles.label}>{t('order.field.build')}</dt>
								<dd className={styles.value}>
									{t(`job.status.${latestJob.status}`)} ·{' '}
									{t('order.page.tokens', {
										used: latestJob.tokensUsed.toLocaleString(i18n.language),
										budget: latestJob.budget.maxTokens.toLocaleString(i18n.language),
									})}
								</dd>
							</>
						)}
						<dt className={styles.label}>{t('order.field.created')}</dt>
						<dd className={styles.value}>
							{new Date(order.createdAt).toLocaleString(i18n.language)}
						</dd>
					</dl>

					{cancellable.has(order.status) && (
						<div className={styles.cancel}>
							<Button
								color="danger"
								size="small"
								disabled={isCancelling}
								onClick={() => cancel(order.id)}
							>
								{t('order.action.cancel')}
							</Button>
						</div>
					)}
				</section>

				<aside className={styles.side}>
					<PaymentPanel detail={detail} />
				</aside>
			</div>
		</>
	)
}

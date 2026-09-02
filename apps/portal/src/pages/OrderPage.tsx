import styles from './OrderPage.module.css'

import { useTranslation } from 'react-i18next'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { customerCancellableOrderStatus, isActiveJobStatus } from '@mf/models'

import { usePermission } from '#/hooks/usePermission.ts'
import { useGetJobQuery } from '#/features/jobs/jobsApiSlice.ts'
import { nextStep } from '#/features/orders/nextStep.ts'
import { useCancelOrderMutation, useGetOrderQuery } from '#/features/orders/ordersApiSlice.ts'
import { Deliverables } from '#/features/jobs/Deliverables.tsx'
import { GateReports } from '#/features/jobs/GateReports.tsx'
import { ApprovalPanel } from '#/features/orders/ApprovalPanel.tsx'
import { HostingPanel } from '#/features/orders/HostingPanel.tsx'
import { OrderStatusBadge } from '#/features/orders/OrderStatusBadge.tsx'
import { OrderStepper } from '#/features/orders/OrderStepper.tsx'
import { PaymentPanel } from '#/features/orders/PaymentPanel.tsx'

import { Button } from '#/components/Button.tsx'
import { Spinner } from '#/components/Spinner.tsx'

import type { OrderDetail } from '@mf/models'

const pollingInterval = 5000

/** Admins may also cancel after the deposit (the build is killed, the deposit refunded) */
const adminCancellable = new Set<OrderDetail['order']['status']>([
	...customerCancellableOrderStatus,
	'deposit_paid',
	'building',
	'awaiting_approval',
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
	// The full job row carries the gate reports; the order detail only has a summary of it.
	// Polled only while the build runs — a finished job's gates and deliverables never change.
	const latestJobId = detail?.latestJob?.id ?? ''
	const latestActive = detail?.latestJob ? isActiveJobStatus(detail.latestJob.status) : false
	const { data: job } = useGetJobQuery(latestJobId, {
		skip: !latestJobId,
		pollingInterval: latestActive ? pollingInterval : 0,
	})
	const { hasPermission } = usePermission()
	const cancellable = hasPermission('job:admin')
		? adminCancellable
		: new Set(customerCancellableOrderStatus)

	if (isLoading) return <Spinner center />
	if (isError || !detail) return <p className={styles.error}>{t('order.page.loadError')}</p>

	const { order, latestJob, spec, hosting } = detail
	const paymentResult = searchParams.get('payment')

	return (
		<>
			<div className={styles.heading}>
				<h1 className={styles.title}>{order.name || t('order.page.untitled')}</h1>
				<OrderStatusBadge status={order.status} hosting={hosting.status} />
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

			<OrderStepper status={order.status} priceSek={order.priceSek} />

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
								{t(latestActive ? 'order.action.followBuild' : 'order.action.viewBuild')}
							</Link>
						)}
					</div>

					<dl className={styles.facts}>
						<dt className={styles.label}>{t('order.field.kind')}</dt>
						<dd className={styles.value}>{t(`order.kind.${order.kind}`)}</dd>
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
									{latestJob.mode === 'redeliver' && `${t('job.mode.redeliver')} · `}
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
					<ApprovalPanel orderId={order.id} status={order.status} job={job} />
					<HostingPanel detail={detail} />
					<PaymentPanel detail={detail} />
					{job && (
						<>
							<GateReports gates={job.gates} />
							<Deliverables job={job} />
						</>
					)}
				</aside>
			</div>
		</>
	)
}

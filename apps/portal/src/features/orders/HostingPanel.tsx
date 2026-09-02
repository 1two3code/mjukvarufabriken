import styles from './HostingPanel.module.css'

import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { isActiveJobStatus } from '@mf/models'

import { useRedeliverJobMutation } from '#/features/jobs/jobsApiSlice.ts'

import { Button } from '#/components/Button.tsx'

import type { OrderDetail } from '@mf/models'

type HostingPanelProps = {
	detail: OrderDetail
}

/**
 * What the customer actually got (wave 14, F7). `live`: the preview URL. `unhosted`: the code
 * and the handover bundle are delivered but the preview could not be brought up — says why and
 * offers "Deliver again" (a `redeliver` job: the hosting half only, no rebuild). Nothing before
 * the first delivery.
 */
export function HostingPanel({ detail }: HostingPanelProps) {
	const { t } = useTranslation()
	const [redeliver, { isLoading }] = useRedeliverJobMutation()
	const { order, hosting, latestJob } = detail
	if (hosting.status === 'none') return null

	const deliveryRunning = latestJob ? isActiveJobStatus(latestJob.status) : false

	return (
		<section
			className={[styles.panel, hosting.status === 'live' ? styles.live : styles.unhosted].join(
				' '
			)}
			aria-label={t('order.hosting.title')}
		>
			<h2 className={styles.title}>{t('order.hosting.title')}</h2>
			{hosting.status === 'live' ? (
				<>
					<p className={styles.body}>{t('order.hosting.live')}</p>
					<p className={styles.body}>
						<a href={hosting.deployUrl ?? undefined} target="_blank" rel="noreferrer">
							{t('order.hosting.open')}
						</a>
					</p>
				</>
			) : (
				<>
					<p className={styles.body}>{t('order.hosting.unhosted')}</p>
					<p className={styles.reason}>
						{hosting.reason
							? t('order.hosting.reason', { reason: hosting.reason })
							: t('order.hosting.noReason')}
					</p>
					{deliveryRunning ? (
						<p className={styles.body}>
							<Link to={`/orders/${order.id}/job`}>{t('order.hosting.redeliverRunning')}</Link>
						</p>
					) : (
						<div className={styles.actions}>
							<Button size="small" disabled={isLoading} onClick={() => redeliver(order.id)}>
								{t('job.card.action.redeliver')}
							</Button>
							<Link to={`/orders/${order.id}/job`}>{t('order.action.viewBuild')}</Link>
						</div>
					)}
					<p className={styles.hint}>{t('job.card.action.redeliverHint')}</p>
				</>
			)}
		</section>
	)
}

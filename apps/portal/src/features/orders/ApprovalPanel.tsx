import styles from './ApprovalPanel.module.css'

import { useTranslation } from 'react-i18next'
import { isOrderAwaitingApproval } from '@mf/models'

import { useApproveOrderMutation } from '#/features/orders/ordersApiSlice.ts'
import { gateSummary } from '#/features/orders/approval.ts'
import { useGetJobDeliverablesQuery } from '#/features/jobs/jobsApiSlice.ts'

import { Button } from '#/components/Button.tsx'

import type { Job, OrderStatus } from '@mf/models'

type ApprovalPanelProps = {
	orderId: string
	status: OrderStatus
	/** The full job row (carries the gate reports); undefined until it is loaded */
	job?: Job
}

/**
 * The approve-before-deliver gate (W7). Shown only while the order is `awaiting_approval`: it
 * surfaces the QA gate tally, the preview URL and the repository (the diff) and lets a customer
 * or admin approve, which delivers the order. Hidden entirely when the gate is off — the order
 * never enters `awaiting_approval` — so the default auto-deliver flow shows nothing here.
 */
export function ApprovalPanel({ orderId, status, job }: ApprovalPanelProps) {
	const { t } = useTranslation()
	const [approve, { isLoading }] = useApproveOrderMutation()
	const { data: deliverables } = useGetJobDeliverablesQuery(job?.id ?? '', { skip: !job })

	if (!isOrderAwaitingApproval(status)) return null

	const summary = gateSummary(job?.gates)
	const repositoryUrl = deliverables?.repositoryUrl ?? job?.repositoryUrl
	const previewUrl = deliverables?.deployUrl

	return (
		<section className={styles.panel} aria-label={t('order.approval.title')}>
			<h2 className={styles.title}>{t('order.approval.title')}</h2>
			<p className={styles.intro}>{t('order.approval.intro')}</p>

			<p className={[styles.gates, summary.allPassed ? styles.ok : styles.warn].join(' ')}>
				{t('order.approval.gates', { passed: summary.passed, total: summary.total })}
			</p>

			<ul className={styles.links}>
				{previewUrl && (
					<li>
						<a href={previewUrl} target="_blank" rel="noreferrer">
							{t('order.approval.preview')}
						</a>
					</li>
				)}
				{repositoryUrl && (
					<li>
						<a href={repositoryUrl} target="_blank" rel="noreferrer">
							{t('order.approval.diff')}
						</a>
					</li>
				)}
			</ul>

			<div className={styles.actions}>
				<Button disabled={isLoading} onClick={() => approve(orderId)}>
					{t('order.approval.approve')}
				</Button>
			</div>
			<p className={styles.hint}>{t('order.approval.hint')}</p>
		</section>
	)
}

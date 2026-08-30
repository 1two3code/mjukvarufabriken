import styles from './ApprovalPanel.module.css'

import { useTranslation } from 'react-i18next'
import { isOrderAwaitingApproval } from '@mf/models'

import { useGetJobDeliverablesQuery } from '#/features/jobs/jobsApiSlice.ts'
import { gateSummary } from '#/features/orders/approval.ts'
import { useApproveOrderMutation } from '#/features/orders/ordersApiSlice.ts'

import { Button } from '#/components/Button.tsx'

import type { Job, OrderStatus } from '@mf/models'

type ApprovalPanelProps = {
	orderId: string
	status: OrderStatus
	/** The full job row (carries the gate reports); undefined until it is loaded */
	job?: Job
}

/**
 * The customer-facing order-approval step (W7). Shown only while the order is `awaiting_approval`:
 * it surfaces the QA gate tally, the preview URL and the repository (the diff) and lets a customer
 * or admin accept the order, which moves it to `delivered` and opens the balance invoice. Hidden
 * entirely when the gate is off — the order never enters `awaiting_approval` — so the default
 * auto-deliver flow shows nothing here.
 *
 * Honest scope: this approves the ORDER, not the build. By the time the panel shows, the harness
 * job has already delivered (repo pushed / gone live) — see `orderService.syncWithJob`. Approving
 * only flips the customer-facing order status. A true pre-delivery HOLD (pausing the harness before
 * repo push / go-live) is a follow-up that needs a harness change and is out of this stream.
 *
 * The approve button is disabled whenever the gates are not all green (an admin must not approve a
 * build whose quality gates failed) or while the approval mutation is in flight.
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
				<Button disabled={isLoading || !summary.allPassed} onClick={() => approve(orderId)}>
					{t('order.approval.approve')}
				</Button>
			</div>
			<p className={styles.hint}>{t('order.approval.hint')}</p>
		</section>
	)
}

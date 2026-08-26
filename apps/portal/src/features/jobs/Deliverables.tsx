import styles from './Deliverables.module.css'

import { useTranslation } from 'react-i18next'

import { useGetJobDeliverablesQuery } from '#/features/jobs/jobsApiSlice.ts'

import type { Job } from '@mf/models'

type DeliverablesProps = {
	job: Job
}

/**
 * Download links from `GET /bff/jobs/:id/deliverables` (M5) for a delivered job. The endpoint
 * ships with the delivery stream; until then (or for an undelivered job) the section says so.
 */
export function Deliverables({ job }: DeliverablesProps) {
	const { t } = useTranslation()
	const delivered = job.status === 'delivered'
	const { data: deliverables, isError } = useGetJobDeliverablesQuery(job.id, { skip: !delivered })

	return (
		<section className={styles.deliverables}>
			<h2 className={styles.title}>{t('job.deliverables.title')}</h2>
			{job.repositoryUrl && (
				<p className={styles.repository}>
					<a href={job.repositoryUrl} target="_blank" rel="noreferrer">
						{t('job.deliverables.repository')}
					</a>
				</p>
			)}
			{!delivered && <p className={styles.empty}>{t('job.deliverables.notDelivered')}</p>}
			{delivered && (isError || deliverables?.length === 0) && (
				<p className={styles.empty}>{t('job.deliverables.none')}</p>
			)}
			{!!deliverables?.length && (
				<ul className={styles.list}>
					{deliverables.map(deliverable => (
						<li key={deliverable.url}>
							<a href={deliverable.url} target="_blank" rel="noreferrer">
								{deliverable.name}
							</a>
							{deliverable.description && (
								<span className={styles.description}> — {deliverable.description}</span>
							)}
						</li>
					))}
				</ul>
			)}
		</section>
	)
}

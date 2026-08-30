import styles from './Deliverables.module.css'

import { useTranslation } from 'react-i18next'

import { useGetJobDeliverablesQuery } from '#/features/jobs/jobsApiSlice.ts'

import type { Job } from '@mf/models'

const formatSize = (bytes: number) =>
	bytes < 1024
		? `${bytes} B`
		: bytes < 1024 ** 2
			? `${Math.round(bytes / 1024)} kB`
			: `${(bytes / 1024 ** 2).toFixed(1)} MB`

type DeliverablesProps = {
	job: Job
}

/**
 * The delivery record from `GET /bff/jobs/:id/deliverables` (M5) for a delivered job: repo,
 * preview URL and the bundle files with 15-minute download links. For an undelivered job (or a
 * delivered one without a bundle) the section says so.
 */
export function Deliverables({ job }: DeliverablesProps) {
	const { t } = useTranslation()
	const delivered = job.status === 'delivered'
	const { data: deliverables, isError } = useGetJobDeliverablesQuery(job.id, { skip: !delivered })
	const repositoryUrl = deliverables?.repositoryUrl ?? job.repositoryUrl

	return (
		<section className={styles.deliverables}>
			<h2 className={styles.title}>{t('job.deliverables.title')}</h2>
			{repositoryUrl && (
				<p className={styles.repository}>
					<a href={repositoryUrl} target="_blank" rel="noreferrer">
						{t('job.deliverables.repository')}
					</a>
					{deliverables?.transferPending && (
						<span className={styles.description}> — {t('job.deliverables.transferPending')}</span>
					)}
				</p>
			)}
			{deliverables?.deployUrl && (
				<p className={styles.repository}>
					<a href={deliverables.deployUrl} target="_blank" rel="noreferrer">
						{t('job.deliverables.preview')}
					</a>
				</p>
			)}
			{!delivered && <p className={styles.empty}>{t('job.deliverables.notDelivered')}</p>}
			{delivered && (isError || deliverables?.files.length === 0) && (
				<p className={styles.empty}>{t('job.deliverables.none')}</p>
			)}
			{!!deliverables?.files.length && (
				<ul className={styles.list}>
					{deliverables.files.map(file => (
						<li key={file.key}>
							<a href={file.url} target="_blank" rel="noreferrer">
								{file.name}
							</a>
							<span className={styles.description}> — {formatSize(file.size)}</span>
						</li>
					))}
				</ul>
			)}
		</section>
	)
}

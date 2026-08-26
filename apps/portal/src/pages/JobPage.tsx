import styles from './JobPage.module.css'

import { useTranslation } from 'react-i18next'
import { Link, useParams } from 'react-router-dom'
import { isActiveJobStatus } from '@mf/models'

import { useGetJobQuery, useGetOrderJobsQuery } from '#/features/jobs/jobsApiSlice.ts'
import { Deliverables } from '#/features/jobs/Deliverables.tsx'
import { GateReports } from '#/features/jobs/GateReports.tsx'
import { JobEventLog } from '#/features/jobs/JobEventLog.tsx'
import { JobStatusCard } from '#/features/jobs/JobStatusCard.tsx'

import { Spinner } from '#/components/Spinner.tsx'

const pollingInterval = 3000

export function JobPage() {
	const { t } = useTranslation()
	const { orderId = '' } = useParams()
	const { data: jobs, isLoading, isError } = useGetOrderJobsQuery(orderId, { skip: !orderId })
	const latestId = jobs?.[0]?.id
	const latestActive = jobs?.[0] ? isActiveJobStatus(jobs[0].status) : false
	const { data: job } = useGetJobQuery(latestId ?? '', {
		skip: !latestId,
		pollingInterval: latestActive ? pollingInterval : 0,
	})

	if (isLoading) return <Spinner center />
	if (isError) return <p className={styles.error}>{t('job.page.loadError')}</p>

	return (
		<>
			<h1>{t('job.page.title', { orderId })}</h1>
			<p className={styles.intro}>
				<Link to={`/orders/${orderId}`}>{t('job.page.backToOrder')}</Link>
				{' · '}
				<Link to={`/orders/${orderId}/spec`}>{t('job.page.backToSpec')}</Link>
			</p>
			{!job ? (
				<p className={styles.empty}>{t('job.page.noJob')}</p>
			) : (
				<div className={styles.layout}>
					<JobEventLog job={job} />
					<aside className={styles.side}>
						<JobStatusCard job={job} />
						<GateReports gates={job.gates} />
						<Deliverables job={job} />
					</aside>
				</div>
			)}
		</>
	)
}

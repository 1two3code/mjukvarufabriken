import styles from './JobPage.module.css'

import { useTranslation } from 'react-i18next'
import { Link, useParams } from 'react-router-dom'

import { jobsApiSlice, useGetJobQuery, useGetOrderJobsQuery } from '#/features/jobs/jobsApiSlice.ts'
import { jobPollingInterval } from '#/features/jobs/polling.ts'
import { Deliverables } from '#/features/jobs/Deliverables.tsx'
import { GateReports } from '#/features/jobs/GateReports.tsx'
import { JobEventLog } from '#/features/jobs/JobEventLog.tsx'
import { JobStatusCard } from '#/features/jobs/JobStatusCard.tsx'

import { Spinner } from '#/components/Spinner.tsx'

export function JobPage() {
	const { t } = useTranslation()
	const { orderId = '' } = useParams()
	const { data: jobs, isLoading, isError } = useGetOrderJobsQuery(orderId, { skip: !orderId })
	const latestId = jobs?.[0]?.id

	// The already-cached detail row — no extra request, no extra subscription. The job list above
	// is fetched once and never polled, so deciding from it alone kept the 3 s poll running for
	// ever once a job finished; the row the poll refreshes is the one that knows it is done.
	const { data: polled } = jobsApiSlice.endpoints.getJob.useQueryState(latestId ?? '', {
		skip: !latestId,
	})
	const { data: job } = useGetJobQuery(latestId ?? '', {
		skip: !latestId,
		pollingInterval: jobPollingInterval(polled, jobs),
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
						<GateReports gates={job.gates} expanded />
						<Deliverables job={job} />
					</aside>
				</div>
			)}
		</>
	)
}

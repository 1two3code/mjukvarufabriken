import styles from './JobPage.module.css'

import { useTranslation } from 'react-i18next'
import { Link, useParams, useSearchParams } from 'react-router-dom'

import { jobsApiSlice, useGetJobQuery, useGetOrderJobsQuery } from '#/features/jobs/jobsApiSlice.ts'
import { jobPollingInterval } from '#/features/jobs/polling.ts'
import { Deliverables } from '#/features/jobs/Deliverables.tsx'
import { DeliveryTimeline } from '#/features/jobs/DeliveryTimeline.tsx'
import { GateReports } from '#/features/jobs/GateReports.tsx'
import { JobEventLog } from '#/features/jobs/JobEventLog.tsx'
import { JobList } from '#/features/jobs/JobList.tsx'
import { JobStatusCard } from '#/features/jobs/JobStatusCard.tsx'

import { Spinner } from '#/components/Spinner.tsx'

/** Query param naming the selected job; absent = the newest one */
const selectedJobParam = 'job'

export function JobPage() {
	const { t } = useTranslation()
	const { orderId = '' } = useParams()
	const [searchParams, setSearchParams] = useSearchParams()
	const { data: jobs, isLoading, isError } = useGetOrderJobsQuery(orderId, { skip: !orderId })
	const latestId = jobs?.[0]?.id
	// The selection lives in the URL (linkable from the order page; no React state, so the page
	// stays a plain function of its queries). An unknown id falls back to the newest job.
	const requestedId = searchParams.get(selectedJobParam)
	const selectedId = jobs?.some(job => job.id === requestedId) ? requestedId! : latestId

	// The already-cached detail row — no extra request, no extra subscription. The job list above
	// is fetched once and never polled, so deciding from it alone kept the 3 s poll running for
	// ever once a job finished; the row the poll refreshes is the one that knows it is done.
	const { data: polled } = jobsApiSlice.endpoints.getJob.useQueryState(selectedId ?? '', {
		skip: !selectedId,
	})
	const { data: job } = useGetJobQuery(selectedId ?? '', {
		skip: !selectedId,
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
				<>
					{jobs && (
						<JobList
							jobs={jobs}
							selectedJobId={job.id}
							onSelect={selected => setSearchParams({ [selectedJobParam]: selected.id })}
						/>
					)}
					<div className={styles.layout}>
						<JobEventLog job={job} />
						<aside className={styles.side}>
							<JobStatusCard job={job} />
							<DeliveryTimeline job={job} />
							<GateReports gates={job.gates} expanded />
							<Deliverables job={job} />
						</aside>
					</div>
				</>
			)}
		</>
	)
}

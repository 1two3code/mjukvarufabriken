import styles from './JobOutcome.module.css'

import { useTranslation } from 'react-i18next'

import { jobOutcome } from '#/features/jobs/delivery.ts'
import { useGetJobDeliverablesQuery } from '#/features/jobs/jobsApiSlice.ts'

import type { Job } from '@mf/models'
import type { JobOutcomeKind } from '#/features/jobs/delivery.ts'

type JobOutcomeProps = {
	job: Pick<Job, 'id' | 'status' | 'reason'>
	/**
	 * Load the delivery record to tell `live` from `unhosted` (one small request per delivered
	 * job, cached). Off for lists that must stay cheap — a delivered job then reads `delivered`
	 * (or `unhosted` when the row carries the withheld-URL reason), never `live`.
	 */
	withDeliverables?: boolean
}

const toneByKind: Record<JobOutcomeKind, string> = {
	running: styles.neutral,
	live: styles.success,
	delivered: styles.success,
	unhosted: styles.caution,
	failed: styles.error,
	killed: styles.error,
}

/** One line: what the job amounted to — live URL, unhosted with its reason, or the failure */
export function JobOutcome({ job, withDeliverables = false }: JobOutcomeProps) {
	const { t } = useTranslation()
	const { data: deliverables, isError } = useGetJobDeliverablesQuery(job.id, {
		skip: !withDeliverables || job.status !== 'delivered',
	})
	// A 404 (delivered before the bundle existed) is "no record", i.e. hosting unknown
	const deployUrl = withDeliverables && !isError ? deliverables?.deployUrl : undefined
	const outcome = jobOutcome(job, deployUrl)

	return (
		<span className={styles.outcome} title={outcome.reason}>
			<span className={[styles.label, toneByKind[outcome.kind]].join(' ')}>
				{t(`job.outcome.${outcome.kind}`)}
			</span>
			{outcome.url && (
				<a href={outcome.url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}>
					{t('job.deliverables.preview')}
				</a>
			)}
			{outcome.reason && <span className={styles.reason}>{outcome.reason}</span>}
		</span>
	)
}

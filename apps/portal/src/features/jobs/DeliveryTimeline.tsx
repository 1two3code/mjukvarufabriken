import styles from './DeliveryTimeline.module.css'

import { useTranslation } from 'react-i18next'

import { deliveryTimeline, hasDeliverySteps } from '#/features/jobs/delivery.ts'
import { useGetJobEventsQuery } from '#/features/jobs/jobsApiSlice.ts'

import type { Job } from '@mf/models'
import type { DeliveryStepState } from '#/features/jobs/delivery.ts'

type DeliveryTimelineProps = {
	job: Job
}

const toneByState: Record<DeliveryStepState['state'], string> = {
	ok: styles.ok,
	failed: styles.failed,
	pending: styles.pending,
}

/**
 * The delivery half of a job, step by step: docs → secret scan → repo → deploy → live check →
 * bundle, each with its verdict, reason and URL. Reads the same event cache the log uses (one
 * query per job id), so it costs no extra request. Hidden until the first step has reported.
 */
export function DeliveryTimeline({ job }: DeliveryTimelineProps) {
	const { t } = useTranslation()
	const { data: events = [] } = useGetJobEventsQuery({ jobId: job.id, after: 0 })
	const timeline = deliveryTimeline(events)
	if (!hasDeliverySteps(timeline)) return null

	return (
		<section className={styles.timeline}>
			<h2 className={styles.title}>{t('job.timeline.title')}</h2>
			<ol className={styles.steps}>
				{timeline.map(({ step, state, reason, url }) => (
					<li key={step} className={[styles.step, toneByState[state]].join(' ')}>
						<span className={styles.marker} aria-hidden="true" />
						<span className={styles.name}>{t(`delivery.step.${step}`)}</span>
						<span className={styles.verdict}>{t(`job.timeline.${state}`)}</span>
						{(reason || url) && (
							<span className={styles.detail}>
								{reason}
								{url && (
									<a href={url} target="_blank" rel="noreferrer">
										{t('job.timeline.open')}
									</a>
								)}
							</span>
						)}
					</li>
				))}
			</ol>
		</section>
	)
}

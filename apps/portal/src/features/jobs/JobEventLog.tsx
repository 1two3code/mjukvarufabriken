import styles from './JobEventLog.module.css'

import { useTranslation } from 'react-i18next'
import { isActiveJobStatus } from '@mf/models'

import { useGetJobEventsQuery } from '#/features/jobs/jobsApiSlice.ts'

import type { TFunction } from 'i18next'
import type { Job, JobEvent, JobEventType } from '@mf/models'

type JobEventLogProps = {
	job: Job
}

const pollingInterval = 3000

const toneByType: Partial<Record<JobEventType, string>> = {
	done: styles.success,
	task_finished: styles.success,
	verify: styles.success,
	planned: styles.info,
	task_started: styles.info,
	merge: styles.info,
	failed: styles.error,
	killed: styles.error,
	task_failed: styles.error,
	retry: styles.info,
}

/** Tone of a `gate` event depends on its verdict, not its type */
const toneOf = (event: JobEvent) =>
	event.type === 'gate'
		? event.payload.ok
			? styles.success
			: styles.error
		: (toneByType[event.type] ?? '')

const eventText = (event: JobEvent, t: TFunction) => {
	const { payload } = event
	switch (event.type) {
		case 'planned': {
			const plan = payload.plan as { summary?: string; tasks?: { title: string }[] } | undefined
			return t('job.event.planned', {
				count: plan?.tasks?.length ?? 0,
				summary: plan?.summary ?? '',
			})
		}
		case 'task_started':
			return t('job.event.taskStarted', { title: payload.title ?? payload.taskId })
		case 'task_finished':
			return t('job.event.taskFinished', { taskId: payload.taskId, tokens: payload.tokens })
		case 'task_failed':
			return t('job.event.taskFailed', { taskId: payload.taskId, reason: payload.reason ?? '' })
		case 'merge':
			return t(payload.ok ? 'job.event.merged' : 'job.event.mergeFailed', {
				taskId: payload.taskId,
				reason: payload.reason ?? '',
			})
		case 'verify':
			return t(payload.ok ? 'job.event.verifyOk' : 'job.event.verifyFailed', {
				output: payload.output ?? '',
			})
		case 'done':
			// Judged by the URL itself, never by `reason` alone: a delivered job whose preview URL
			// was withheld (`deployUrl: null`) says so, and why when the harness recorded it
			if (payload.deployUrl !== null) return t('job.event.done', { tokens: payload.tokensUsed })
			return payload.reason
				? t('job.event.doneUnhosted', { tokens: payload.tokensUsed, reason: payload.reason })
				: t('job.event.doneUnhostedNoReason', { tokens: payload.tokensUsed })
		case 'failed':
		case 'killed':
			return t(`job.event.${event.type}`, { reason: payload.reason ?? '' })
		case 'started':
			return t('job.event.started')
		case 'gate':
			return t(payload.ok ? 'job.event.gateOk' : 'job.event.gateFailed', {
				name: payload.name,
				summary: payload.summary ?? '',
			})
		case 'delivery':
			return t(payload.ok ? 'job.event.deliveryOk' : 'job.event.deliveryFailed', {
				step: t(`delivery.step.${String(payload.step)}`),
				reason: payload.reason ?? '',
			})
		case 'notify':
			// Admin-only: customers never receive `notify` events (redacted by the api)
			return t('job.event.notify', { subject: payload.subject ?? '' })
		case 'retry':
			// Both rows of an automatic rebuild carry one: the failed job `{retryJobId}`, the retry
			// `{ofJobId, attempt}` (db.jobs.insertRetry)
			return payload.retryJobId
				? t('job.event.retrySpawned', { jobId: payload.retryJobId })
				: t('job.event.retryOf', { jobId: payload.ofJobId ?? '' })
		default:
			return JSON.stringify(payload)
	}
}

/** Live log: polls `events?after=<last id>` every 3 s while the job is active */
export function JobEventLog({ job }: JobEventLogProps) {
	const { t, i18n } = useTranslation()
	const active = isActiveJobStatus(job.status)
	const { data: events = [] } = useGetJobEventsQuery(
		{ jobId: job.id, after: 0 },
		{ pollingInterval: active ? pollingInterval : 0 }
	)
	// Ask only for what we have not seen; RTK Query merges the pages under the job id
	const after = events.at(-1)?.id ?? 0
	useGetJobEventsQuery(
		{ jobId: job.id, after },
		{ pollingInterval: active ? pollingInterval : 0, skip: after === 0 }
	)

	return (
		<section className={styles.log} aria-live="polite">
			<h2 className={styles.title}>{t('job.log.title')}</h2>
			{events.length === 0 && <p className={styles.empty}>{t('job.log.empty')}</p>}
			<ol className={styles.list}>
				{events.map(event => (
					<li key={event.id} className={[styles.item, toneOf(event)].join(' ')}>
						<time className={styles.time} dateTime={event.createdAt}>
							{new Date(event.createdAt).toLocaleTimeString(i18n.language)}
						</time>
						<span className={styles.type}>{event.type}</span>
						<span className={styles.text}>{eventText(event, t)}</span>
					</li>
				))}
			</ol>
		</section>
	)
}

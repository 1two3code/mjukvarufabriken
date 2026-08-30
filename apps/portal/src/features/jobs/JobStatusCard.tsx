import styles from './JobStatusCard.module.css'

import { useTranslation } from 'react-i18next'
import { isActiveJobStatus } from '@mf/models'

import { useKillJobMutation } from '#/features/jobs/jobsApiSlice.ts'

import { Has } from '#/layouts/Has.tsx'
import { Button } from '#/components/Button.tsx'

import type { Job, JobStatus } from '@mf/models'

type JobStatusCardProps = {
	job: Job
}

const statusTone: Record<JobStatus, string> = {
	queued: styles.neutral,
	planning: styles.active,
	building: styles.active,
	verifying: styles.active,
	delivered: styles.success,
	failed: styles.error,
	killed: styles.error,
}

const formatTokens = (value: number, language: string) =>
	value >= 1_000_000
		? `${(value / 1_000_000).toLocaleString(language, { maximumFractionDigits: 2 })} M`
		: value.toLocaleString(language)

export function JobStatusCard({ job }: JobStatusCardProps) {
	const { t, i18n } = useTranslation()
	const [kill, { isLoading: isKilling }] = useKillJobMutation()
	const percent = Math.min(100, Math.round((job.tokensUsed / job.budget.maxTokens) * 100))
	const active = isActiveJobStatus(job.status)

	return (
		<section className={styles.card}>
			<div className={styles.header}>
				<h2 className={styles.title}>{t('job.card.title')}</h2>
				<span className={[styles.status, statusTone[job.status]].join(' ')}>
					{t(`job.status.${job.status}`)}
				</span>
			</div>

			<dl className={styles.facts}>
				<dt className={styles.label}>{t('job.card.tokens')}</dt>
				<dd className={styles.value}>
					{t('job.card.tokensValue', {
						used: formatTokens(job.tokensUsed, i18n.language),
						budget: formatTokens(job.budget.maxTokens, i18n.language),
						percent,
					})}
					<progress className={styles.progress} max={100} value={percent} />
				</dd>
				<dt className={styles.label}>{t('job.card.workers')}</dt>
				<dd className={styles.value}>{job.budget.maxWorkers}</dd>
				<dt className={styles.label}>{t('job.card.started')}</dt>
				<dd className={styles.value}>
					{job.startedAt ? new Date(job.startedAt).toLocaleString(i18n.language) : '–'}
				</dd>
				<dt className={styles.label}>{t('job.card.finished')}</dt>
				<dd className={styles.value}>
					{job.finishedAt ? new Date(job.finishedAt).toLocaleString(i18n.language) : '–'}
				</dd>
				{job.plan && (
					<>
						<dt className={styles.label}>{t('job.card.tasks')}</dt>
						<dd className={styles.value}>{job.plan.tasks.length}</dd>
					</>
				)}
			</dl>

			{job.reason && <p className={styles.reason}>{job.reason}</p>}

			{active && (
				<Has permissions={['job:admin']}>
					<div className={styles.actions}>
						<Button color="danger" size="small" disabled={isKilling} onClick={() => kill(job.id)}>
							{t('job.card.action.kill')}
						</Button>
					</div>
				</Has>
			)}
		</section>
	)
}

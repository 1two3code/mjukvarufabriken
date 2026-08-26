import styles from './AdminTotals.module.css'

import { useTranslation } from 'react-i18next'
import { isActiveJobStatus } from '@mf/models'

import type { Job } from '@mf/models'

type AdminTotalsProps = {
	jobs: Job[]
}

const isToday = (iso: string) => {
	const date = new Date(iso)
	const now = new Date()
	return (
		date.getFullYear() === now.getFullYear() &&
		date.getMonth() === now.getMonth() &&
		date.getDate() === now.getDate()
	)
}

export const formatTokens = (value: number, language: string) =>
	value >= 1_000_000
		? `${(value / 1_000_000).toLocaleString(language, { maximumFractionDigits: 2 })} M`
		: value.toLocaleString(language)

/** Jobs today, tokens today (jobs created today), active jobs right now */
export function AdminTotals({ jobs }: AdminTotalsProps) {
	const { t, i18n } = useTranslation()
	const today = jobs.filter(job => isToday(job.createdAt))
	const tokensToday = today.reduce((sum, job) => sum + job.tokensUsed, 0)
	const active = jobs.filter(job => isActiveJobStatus(job.status)).length

	const totals = [
		{ label: t('admin.totals.jobsToday'), value: today.length.toLocaleString(i18n.language) },
		{ label: t('admin.totals.tokensToday'), value: formatTokens(tokensToday, i18n.language) },
		{ label: t('admin.totals.active'), value: active.toLocaleString(i18n.language) },
		{ label: t('admin.totals.jobsTotal'), value: jobs.length.toLocaleString(i18n.language) },
	]

	return (
		<dl className={styles.totals}>
			{totals.map(total => (
				<div key={total.label} className={styles.total}>
					<dt className={styles.label}>{total.label}</dt>
					<dd className={styles.value}>{total.value}</dd>
				</div>
			))}
		</dl>
	)
}

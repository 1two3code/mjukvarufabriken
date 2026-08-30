import styles from './AdminTotals.module.css'

import { useTranslation } from 'react-i18next'
import { isActiveJobStatus, rawTokens } from '@mf/models'

import { formatUsd } from '#/features/admin/residentBilling.ts'

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

/** Jobs today, budget tokens + raw tokens + cost today (jobs created today), cost total, active jobs */
export function AdminTotals({ jobs }: AdminTotalsProps) {
	const { t, i18n } = useTranslation()
	const today = jobs.filter(job => isToday(job.createdAt))
	const tokensToday = today.reduce((sum, job) => sum + job.tokensUsed, 0)
	// Real spend: raw usage priced at the order's model prices — only jobs run since migration
	// 0018 carry it; the weighted `tokensUsed` above is the budget metric, not cost.
	const costOf = (list: Job[]) => list.reduce((sum, job) => sum + (job.costUsd ?? 0), 0)
	const rawToday = today.reduce((sum, job) => sum + (job.usage ? rawTokens(job.usage) : 0), 0)
	const active = jobs.filter(job => isActiveJobStatus(job.status)).length

	const totals = [
		{ label: t('admin.totals.jobsToday'), value: today.length.toLocaleString(i18n.language) },
		{ label: t('admin.totals.tokensToday'), value: formatTokens(tokensToday, i18n.language) },
		{ label: t('admin.totals.rawTokensToday'), value: formatTokens(rawToday, i18n.language) },
		{ label: t('admin.totals.costToday'), value: formatUsd(costOf(today), i18n.language) },
		{ label: t('admin.totals.costTotal'), value: formatUsd(costOf(jobs), i18n.language) },
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

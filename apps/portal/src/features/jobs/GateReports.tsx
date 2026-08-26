import styles from './GateReports.module.css'

import { useTranslation } from 'react-i18next'

import type { GateReport } from '@mf/models'

type GateReportsProps = {
	gates?: GateReport[]
	/** Open every gate's details from the start (the job page); collapsed on the order page */
	expanded?: boolean
}

/** First line of the summary — what the collapsed row shows */
const headline = (summary: string) => summary.split('\n').find(line => line.trim()) ?? ''

/** `details` is free-form per gate: scalars inline, anything else pretty-printed */
const formatDetail = (value: unknown) =>
	typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
		? String(value)
		: JSON.stringify(value, null, 2)

/** The QA gates (M4) in run order, from `jobs.gates`; absent until the first gate has run */
export function GateReports({ gates, expanded = false }: GateReportsProps) {
	const { t, i18n } = useTranslation()

	return (
		<section className={styles.gates}>
			<h2 className={styles.title}>{t('job.gates.title')}</h2>
			{!gates?.length && <p className={styles.empty}>{t('job.gates.empty')}</p>}
			{!!gates?.length && (
				<ol className={styles.list}>
					{gates.map(gate => (
						<li
							key={`${gate.name}-${gate.startedAt}`}
							className={[styles.gate, gate.ok ? styles.ok : styles.failed].join(' ')}
						>
							<details className={styles.details} open={expanded}>
								<summary className={styles.header}>
									<span className={styles.name}>{t(`job.gates.name.${gate.name}`)}</span>
									<span className={styles.verdict}>
										{t(gate.ok ? 'job.gates.passed' : 'job.gates.failed')}
									</span>
								</summary>
								<p className={styles.summary}>{gate.summary}</p>
								{gate.details && Object.keys(gate.details).length > 0 && (
									<dl className={styles.detailList}>
										{Object.entries(gate.details).map(([key, value]) => (
											<div key={key} className={styles.detail}>
												<dt className={styles.detailKey}>{key}</dt>
												<dd className={styles.detailValue}>{formatDetail(value)}</dd>
											</div>
										))}
									</dl>
								)}
							</details>
							{!expanded && <p className={styles.headline}>{headline(gate.summary)}</p>}
							<span className={styles.meta}>
								{t('job.gates.meta', {
									duration: Math.round(gate.durationMs / 1000).toLocaleString(i18n.language),
									tokens: gate.tokens.toLocaleString(i18n.language),
								})}
							</span>
						</li>
					))}
				</ol>
			)}
		</section>
	)
}

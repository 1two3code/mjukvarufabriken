import styles from './GateReports.module.css'

import { useTranslation } from 'react-i18next'

import type { GateReport } from '@mf/models'

type GateReportsProps = {
	gates?: GateReport[]
}

/** The QA gates (M4) in run order, from `jobs.gates`; absent until the first gate has run */
export function GateReports({ gates }: GateReportsProps) {
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
							<div className={styles.header}>
								<span className={styles.name}>{t(`job.gates.name.${gate.name}`)}</span>
								<span className={styles.verdict}>
									{t(gate.ok ? 'job.gates.passed' : 'job.gates.failed')}
								</span>
							</div>
							<p className={styles.summary}>{gate.summary}</p>
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

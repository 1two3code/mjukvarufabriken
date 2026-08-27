import styles from './GateReports.module.css'

import { useTranslation } from 'react-i18next'

import { usePermission } from '#/hooks/usePermission.ts'
import {
	acceptanceGateSummary,
	formatGateDetail,
	gateHeadline,
	genericGateDetails,
	licenceGateSummary,
	reviewGateSummary,
} from '#/features/jobs/gateReport.ts'

import type { AcceptanceStatus, GateReport, ReviewSeverity } from '@mf/models'

type GateReportsProps = {
	gates?: GateReport[]
	/** Open every gate's details from the start (the job page); collapsed on the order page */
	expanded?: boolean
}

const severityTone: Record<ReviewSeverity, string> = {
	high: styles.high,
	medium: styles.medium,
	low: styles.low,
}

const acceptanceTone: Record<AcceptanceStatus, string> = {
	met: styles.met,
	unmet: styles.unmet,
	unknown: styles.pending,
}

/** A labelled count in the stats row of a gate's expanded details */
function Stat({ label, value }: { label: string; value: number | string }) {
	return (
		<span className={styles.stat}>
			<span className={styles.statValue}>{value}</span>
			<span className={styles.statLabel}>{label}</span>
		</span>
	)
}

/** The structured, admin-only breakdown of one gate's `details`, per gate name */
function GateDetails({ gate }: { gate: GateReport }) {
	const { t, i18n } = useTranslation()
	const format = (value: number) => value.toLocaleString(i18n.language)

	const review = gate.name === 'review' ? reviewGateSummary(gate) : undefined
	const licence = gate.name === 'licence' ? licenceGateSummary(gate) : undefined
	const acceptance = gate.name === 'acceptance-check' ? acceptanceGateSummary(gate) : undefined
	const generic = genericGateDetails(gate)

	if (!review && !licence && !acceptance && generic.length === 0) return null

	return (
		<div className={styles.detailsBody}>
			{review && (
				<>
					<div className={styles.stats}>
						<Stat label={t('job.gates.detail.review.high')} value={format(review.counts.high)} />
						<Stat
							label={t('job.gates.detail.review.medium')}
							value={format(review.counts.medium)}
						/>
						<Stat label={t('job.gates.detail.review.low')} value={format(review.counts.low)} />
						<Stat label={t('job.gates.detail.review.waived')} value={format(review.waived)} />
					</div>
					{review.findings.length > 0 && (
						<ul className={styles.findings}>
							{review.findings.map(finding => (
								<li key={finding.id} className={styles.finding}>
									<span className={[styles.tag, severityTone[finding.severity]].join(' ')}>
										{t(`job.gates.severity.${finding.severity}`)}
									</span>
									<span className={styles.findingText}>
										<code className={styles.findingId}>{finding.id}</code> {finding.claim}
									</span>
								</li>
							))}
						</ul>
					)}
				</>
			)}

			{licence && (
				<>
					<div className={styles.stats}>
						<Stat label={t('job.gates.detail.licence.packages')} value={format(licence.packages)} />
						<Stat
							label={t('job.gates.detail.licence.licences')}
							value={format(Object.keys(licence.byLicence).length)}
						/>
						<Stat
							label={t('job.gates.detail.licence.violations')}
							value={format(licence.violations.length)}
						/>
						<Stat
							label={t('job.gates.detail.licence.waived')}
							value={format(licence.waived.length)}
						/>
						{licence.missing.length > 0 && (
							<Stat
								label={t('job.gates.detail.licence.missing')}
								value={format(licence.missing.length)}
							/>
						)}
					</div>
					{licence.violations.length > 0 && (
						<ul className={styles.findings}>
							{licence.violations.map(violation => (
								<li key={violation.waiverId} className={styles.finding}>
									<span className={[styles.tag, styles.high].join(' ')}>{violation.licence}</span>
									<span className={styles.findingText}>
										<code className={styles.findingId}>
											{violation.name}@{violation.version}
										</code>{' '}
										{violation.reason}
									</span>
								</li>
							))}
						</ul>
					)}
				</>
			)}

			{acceptance && (
				<ul className={styles.criteria}>
					{acceptance.map(entry => (
						<li key={entry.id} className={styles.criterion}>
							<code className={styles.findingId}>{entry.id}</code>
							<span className={[styles.tag, acceptanceTone[entry.status]].join(' ')}>
								{t(`job.gates.acceptance.${entry.status}`)}
							</span>
						</li>
					))}
				</ul>
			)}

			{generic.length > 0 && (
				<dl className={styles.detailList}>
					{generic.map(([key, value]) => (
						<div key={key} className={styles.detail}>
							<dt className={styles.detailKey}>{key}</dt>
							<dd className={styles.detailValue}>{formatGateDetail(value)}</dd>
						</div>
					))}
				</dl>
			)}
		</div>
	)
}

/** The QA gates (M4) in run order, from `jobs.gates`; absent until the first gate has run */
export function GateReports({ gates, expanded = false }: GateReportsProps) {
	const { t, i18n } = useTranslation()
	const { hasPermission } = usePermission()
	// `details` carries harness internals (findings, waiver ids, file lists) — admins only;
	// customers get the summary text
	const showDetails = hasPermission('job:admin')

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
								{showDetails && <GateDetails gate={gate} />}
							</details>
							{!expanded && <p className={styles.headline}>{gateHeadline(gate.summary)}</p>}
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

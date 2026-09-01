import styles from './MarginAssumptionsPanel.module.css'

import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

import { awsPassthroughMarkup } from '#/features/admin/margin.ts'

import type { MarginAssumptions } from '#/features/admin/margin.ts'

const fields = [
	'subscriptionSekPerMonth',
	'tokenMarkup',
	'sekPerUsd',
	'infraPerOrgMonthlyUsd',
] as const
type Field = (typeof fields)[number]

type MarginAssumptionsPanelProps = {
	assumptions: MarginAssumptions
	onChange: (field: Field, value: number) => void
}

/**
 * The knobs of the margin model, editable in place as a what-if — every editable field is read
 * by the calculator (a knob no computation reads renders as a read-only fact instead, like the
 * AWS passthrough markup until its cost feed exists), and none of them persist (the backend has
 * nowhere to store them yet). The one backend-editable input to the cost side, the token model
 * prices, lives on the Pricing tab; the infra allocation default comes from the api's phase-1
 * estimate.
 */
export function MarginAssumptionsPanel({ assumptions, onChange }: MarginAssumptionsPanelProps) {
	const { t } = useTranslation()

	return (
		<section>
			<h2 className={styles.title}>{t('margin.assumptions.title')}</h2>
			<div className={styles.fields}>
				{fields.map(field => (
					<label key={field} className={styles.field}>
						<span className={styles.label}>{t(`margin.assumptions.${field}`)}</span>
						<input
							className={styles.input}
							type="number"
							min={0}
							step="any"
							inputMode="decimal"
							value={assumptions[field]}
							onChange={event => onChange(field, Number(event.target.value))}
						/>
					</label>
				))}
				{/* Decided but not yet modeled (no AWS cost feed) — a fact, not a what-if knob */}
				<div className={styles.field}>
					<span className={styles.label}>{t('margin.assumptions.awsPassthroughMarkup')}</span>
					<span className={styles.fact}>×{awsPassthroughMarkup}</span>
				</div>
			</div>
			<p className={styles.note}>{t('margin.assumptions.awsPassthroughNote')}</p>
			<p className={styles.note}>
				{t('margin.assumptions.note')}{' '}
				<Link to="/admin/pricing">{t('margin.assumptions.pricesLink')}</Link>
			</p>
		</section>
	)
}

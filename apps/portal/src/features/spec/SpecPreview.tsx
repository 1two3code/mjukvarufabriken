import styles from './SpecPreview.module.css'

import { useTranslation } from 'react-i18next'
import { isSpecComplete } from '@mf/models'

import type { SpecDraft } from '@mf/models'

type SpecPreviewProps = {
	draft: SpecDraft
}

type ListProps = {
	label: string
	items?: string[]
}

function SpecList({ label, items }: ListProps) {
	const { t } = useTranslation()
	return (
		<div className={styles.block}>
			<h3 className={styles.blockTitle}>{label}</h3>
			{!items && <p className={styles.missing}>{t('spec.preview.missing')}</p>}
			{items?.length === 0 && <p className={styles.none}>{t('spec.preview.none')}</p>}
			{items && items.length > 0 && (
				<ul className={styles.list}>
					{items.map(item => (
						<li key={item}>{item}</li>
					))}
				</ul>
			)}
		</div>
	)
}

export function SpecPreview({ draft }: SpecPreviewProps) {
	const { t, i18n } = useTranslation()
	const { spec } = draft
	const complete = isSpecComplete(spec)
	const statusClass =
		draft.status === 'frozen' ? styles.frozen : complete ? styles.complete : styles.incomplete

	return (
		<section className={styles.preview}>
			<header className={styles.header}>
				<h2 className={styles.title}>{t('spec.preview.title')}</h2>
				<span className={[styles.status, statusClass].join(' ')}>
					{t(`spec.status.${draft.status}`)}
				</span>
			</header>

			<p className={styles.completeness}>
				{complete ? t('spec.preview.complete') : t('spec.preview.incomplete')}
			</p>

			{spec.sizeClass && draft.priceSek !== undefined && (
				<div className={styles.price}>
					<span className={styles.sizeClass}>
						{t('spec.preview.sizeClass', { size: spec.sizeClass })}
					</span>
					<span className={styles.priceValue}>
						{t('spec.preview.price', { price: draft.priceSek.toLocaleString(i18n.language) })}
					</span>
				</div>
			)}

			<div className={styles.block}>
				<h3 className={styles.blockTitle}>{t('spec.field.goal')}</h3>
				{spec.goal ? (
					<p>{spec.goal}</p>
				) : (
					<p className={styles.missing}>{t('spec.preview.missing')}</p>
				)}
			</div>

			<SpecList label={t('spec.field.users')} items={spec.users} />

			<div className={styles.block}>
				<h3 className={styles.blockTitle}>{t('spec.field.features')}</h3>
				{!spec.features?.length && <p className={styles.missing}>{t('spec.preview.missing')}</p>}
				{spec.features?.map(feature => (
					<article key={feature.title} className={styles.feature}>
						<h4 className={styles.featureTitle}>{feature.title}</h4>
						{feature.description && (
							<p className={styles.featureDescription}>{feature.description}</p>
						)}
						<span className={styles.criteriaLabel}>{t('spec.field.acceptanceCriteria')}</span>
						{feature.acceptanceCriteria.length ? (
							<ul className={styles.list}>
								{feature.acceptanceCriteria.map(criterion => (
									<li key={criterion}>{criterion}</li>
								))}
							</ul>
						) : (
							<p className={styles.missing}>{t('spec.preview.missing')}</p>
						)}
					</article>
				))}
			</div>

			<SpecList label={t('spec.field.nonGoals')} items={spec.nonGoals} />
			<SpecList label={t('spec.field.stackConstraints')} items={spec.stackConstraints} />
		</section>
	)
}

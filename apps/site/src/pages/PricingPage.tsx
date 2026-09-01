import styles from './PricingPage.module.css'

import { useTranslation } from 'react-i18next'

import { usePageMeta } from '#/hooks/usePageMeta.ts'
import { useSiteRoute } from '#/hooks/useSiteRoute.ts'

import { ButtonLink } from '#/components/ButtonLink.tsx'
import { Grid, Section } from '#/components/Section.tsx'

/** The pricing ladder (strategy 2026-08-31): free spec → demo → full build → subscription */
const steps = ['spec', 'demo', 'build', 'managed'] as const
const included = ['repo', 'deployment', 'handover', 'testReport'] as const
const excluded = ['hosting', 'thirdParty'] as const
/** What the 600 kr/mo managed subscription is made of */
const managedPoints = ['hosting', 'support', 'editWork', 'awsResources'] as const

export function PricingPage() {
	const { t } = useTranslation()
	const { pathTo } = useSiteRoute()
	usePageMeta('meta.pricing.title', 'meta.pricing.description')

	return (
		<>
			<Section eyebrow={t('pricing.eyebrow')} lead={t('pricing.lead')}>
				<h1>{t('pricing.title')}</h1>
			</Section>

			<div className={styles.tableWrapper}>
				<table className={styles.table}>
					<thead>
						<tr>
							<th scope="col" className={styles.headerCell}>
								{t('pricing.table.step')}
							</th>
							<th scope="col" className={styles.headerCell}>
								{t('pricing.table.price')}
							</th>
							<th scope="col" className={styles.headerCell}>
								{t('pricing.table.covers')}
							</th>
						</tr>
					</thead>
					<tbody>
						{steps.map((step, index) => (
							<tr key={step} className={styles.row}>
								<th scope="row" className={styles.rowHeader}>
									<span className={styles.sizeLetter}>{index + 1}</span>
									{t(`pricing.step.${step}.name`)}
								</th>
								<td className={styles.price}>{t(`pricing.step.${step}.price`)}</td>
								<td className={styles.cell}>{t(`pricing.step.${step}.covers`)}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
			<p className={styles.note}>{t('pricing.terms')}</p>

			<Grid columns={2}>
				<Section variant="card" title={t('pricing.included.title')}>
					<ul className={styles.list}>
						{included.map(item => (
							<li key={item} className={styles.listItem}>
								<strong>{t(`pricing.included.${item}.title`)}</strong>
								<span>{t(`pricing.included.${item}.body`)}</span>
							</li>
						))}
					</ul>
				</Section>
				<Section variant="card" title={t('pricing.excluded.title')}>
					<ul className={styles.list}>
						{excluded.map(item => (
							<li key={item} className={styles.listItem}>
								<strong>{t(`pricing.excluded.${item}.title`)}</strong>
								<span>{t(`pricing.excluded.${item}.body`)}</span>
							</li>
						))}
					</ul>
				</Section>
			</Grid>

			<Section
				variant="card"
				eyebrow={t('pricing.managed.eyebrow')}
				title={t('pricing.managed.title')}
				lead={t('pricing.managed.lead')}
			>
				<ul className={styles.list}>
					{managedPoints.map(point => (
						<li key={point} className={styles.listItem}>
							<strong>{t(`pricing.managed.point.${point}.title`)}</strong>
							<span>{t(`pricing.managed.point.${point}.body`)}</span>
						</li>
					))}
				</ul>
				<p className={styles.note}>{t('pricing.managed.note')}</p>
			</Section>

			<div className={styles.actions}>
				<ButtonLink href={import.meta.env.VITE_PORTAL_URL}>{t('home.hero.cta')}</ButtonLink>
				<ButtonLink to={pathTo('contact')} color="secondary">
					{t('pricing.cta.contact')}
				</ButtonLink>
			</div>
		</>
	)
}

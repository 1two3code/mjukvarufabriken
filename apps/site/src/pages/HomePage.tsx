import styles from './HomePage.module.css'

import { useTranslation } from 'react-i18next'

import { usePageMeta } from '#/hooks/usePageMeta.ts'
import { useSiteRoute } from '#/hooks/useSiteRoute.ts'

import { ButtonLink } from '#/components/ButtonLink.tsx'
import { Card, Grid, Section } from '#/components/Section.tsx'

const sizes = ['s', 'm', 'l'] as const
const builtPoints = ['sdk', 'sandbox', 'budget', 'review', 'failClosed', 'delivery'] as const

export function HomePage() {
	const { t } = useTranslation()
	const { pathTo } = useSiteRoute()
	usePageMeta('meta.home.title', 'meta.home.description')

	return (
		<>
			<section className={styles.hero}>
				<span className={styles.eyebrow}>{t('home.hero.eyebrow')}</span>
				<h1 className={styles.title}>{t('home.hero.title')}</h1>
				<p className={styles.lead}>{t('home.hero.lead')}</p>
				<div className={styles.actions}>
					<ButtonLink href={import.meta.env.VITE_PORTAL_URL}>{t('home.hero.cta')}</ButtonLink>
					<ButtonLink to={pathTo('howItWorks')} color="secondary">
						{t('home.hero.secondary')}
					</ButtonLink>
				</div>
			</section>

			<Section eyebrow={t('home.what.eyebrow')} title={t('home.what.title')}>
				<Grid columns={3}>
					<Card title={t('home.what.spec.title')} marker="1">
						<p>{t('home.what.spec.body')}</p>
					</Card>
					<Card title={t('home.what.build.title')} marker="2">
						<p>{t('home.what.build.body')}</p>
					</Card>
					<Card title={t('home.what.deliver.title')} marker="3">
						<p>{t('home.what.deliver.body')}</p>
					</Card>
				</Grid>
			</Section>

			<Section
				eyebrow={t('home.sizes.eyebrow')}
				title={t('home.sizes.title')}
				lead={t('home.sizes.lead')}
			>
				<Grid columns={3}>
					{sizes.map(size => (
						<Card key={size} title={t(`pricing.size.${size}.name`)} marker={size.toUpperCase()}>
							<p className={styles.price}>{t(`pricing.size.${size}.price`)}</p>
							<p>{t(`pricing.size.${size}.covers`)}</p>
						</Card>
					))}
				</Grid>
				<p className={styles.note}>{t('home.sizes.note')}</p>
				<div>
					<ButtonLink to={pathTo('pricing')} color="secondary" size="small">
						{t('home.sizes.cta')}
					</ButtonLink>
				</div>
			</Section>

			<Section
				variant="card"
				eyebrow={t('home.built.eyebrow')}
				title={t('home.built.title')}
				lead={t('home.built.lead')}
			>
				<ul className={styles.list}>
					{builtPoints.map(point => (
						<li key={point} className={styles.listItem}>
							<strong>{t(`home.built.${point}.title`)}</strong>
							<span>{t(`home.built.${point}.body`)}</span>
						</li>
					))}
				</ul>
				<p className={styles.note}>{t('home.built.honest')}</p>
			</Section>

			<section className={styles.cta}>
				<h2>{t('home.cta.title')}</h2>
				<p className={styles.lead}>{t('home.cta.body')}</p>
				<div className={styles.actions}>
					<ButtonLink href={import.meta.env.VITE_PORTAL_URL}>{t('home.hero.cta')}</ButtonLink>
					<ButtonLink to={pathTo('contact')} color="secondary">
						{t('home.cta.contact')}
					</ButtonLink>
				</div>
			</section>
		</>
	)
}

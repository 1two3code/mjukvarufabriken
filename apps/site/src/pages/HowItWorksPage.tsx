import styles from './HowItWorksPage.module.css'

import { useTranslation } from 'react-i18next'

import { usePageMeta } from '#/hooks/usePageMeta.ts'
import { useSiteRoute } from '#/hooks/useSiteRoute.ts'

import { ButtonLink } from '#/components/ButtonLink.tsx'
import { Card, Grid, Section } from '#/components/Section.tsx'

const steps = ['spec', 'freeze', 'deposit', 'build', 'qa', 'delivery'] as const
const faq = ['changes', 'fail', 'code', 'hosting', 'login'] as const

export function HowItWorksPage() {
	const { t } = useTranslation()
	const { pathTo } = useSiteRoute()
	usePageMeta('meta.howItWorks.title', 'meta.howItWorks.description')

	return (
		<>
			<Section eyebrow={t('howItWorks.eyebrow')} lead={t('howItWorks.lead')}>
				<h1 className={styles.title}>{t('howItWorks.title')}</h1>
			</Section>

			<ol className={styles.steps}>
				{steps.map((step, index) => (
					<li key={step}>
						<Card title={t(`howItWorks.step.${step}.title`)} marker={String(index + 1)}>
							<p>{t(`howItWorks.step.${step}.body`)}</p>
						</Card>
					</li>
				))}
			</ol>

			<Section
				variant="card"
				eyebrow={t('howItWorks.faq.eyebrow')}
				title={t('howItWorks.faq.title')}
			>
				<Grid columns={2}>
					{faq.map(item => (
						<div key={item} className={styles.faqItem}>
							<h3>{t(`howItWorks.faq.${item}.q`)}</h3>
							<p>{t(`howItWorks.faq.${item}.a`)}</p>
						</div>
					))}
				</Grid>
			</Section>

			<div className={styles.actions}>
				<ButtonLink to={pathTo('quote')}>{t('home.hero.cta')}</ButtonLink>
				<ButtonLink to={pathTo('pricing')} color="secondary">
					{t('nav.pricing')}
				</ButtonLink>
			</div>
		</>
	)
}

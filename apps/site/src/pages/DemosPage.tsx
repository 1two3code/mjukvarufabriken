import styles from './DemosPage.module.css'

import { useTranslation } from 'react-i18next'

import { usePageMeta } from '#/hooks/usePageMeta.ts'
import { useSiteRoute } from '#/hooks/useSiteRoute.ts'
import { ShowcaseGallery } from '#/features/showcases/ShowcaseGallery.tsx'

import { ButtonLink } from '#/components/ButtonLink.tsx'
import { Section } from '#/components/Section.tsx'

/** The public demo gallery: the showcases an admin published, live and clickable (wave 14, F3) */
export function DemosPage() {
	const { t } = useTranslation()
	const { pathTo } = useSiteRoute()
	usePageMeta('meta.demos.title', 'meta.demos.description')

	return (
		<>
			<Section eyebrow={t('demos.eyebrow')} lead={t('demos.lead')}>
				<h1>{t('demos.title')}</h1>
			</Section>

			<ShowcaseGallery />
			<p className={styles.note}>{t('demos.note')}</p>

			<Section variant="card" title={t('demos.cta.title')} lead={t('demos.cta.body')}>
				<div className={styles.actions}>
					<ButtonLink href={import.meta.env.VITE_PORTAL_URL}>{t('home.hero.cta')}</ButtonLink>
					<ButtonLink to={pathTo('pricing')} color="secondary">
						{t('home.ladder.cta')}
					</ButtonLink>
				</div>
			</Section>
		</>
	)
}

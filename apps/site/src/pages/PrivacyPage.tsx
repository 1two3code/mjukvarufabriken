import { useTranslation } from 'react-i18next'

import { usePageMeta } from '#/hooks/usePageMeta.ts'
import { LegalDocument } from '#/features/legal/LegalDocument.tsx'

import { Section } from '#/components/Section.tsx'

/** `/integritet` — Part B (privacy policy incl. cookies) of `legal/villkor-webb.md` */
export function PrivacyPage() {
	const { t } = useTranslation()
	usePageMeta('meta.privacy.title', 'meta.privacy.description')

	return (
		<>
			<Section eyebrow={t('legal.eyebrow')} lead={t('legal.privacy.lead')}>
				<h1>{t('legal.privacy.title')}</h1>
			</Section>
			<LegalDocument part="privacy" />
		</>
	)
}

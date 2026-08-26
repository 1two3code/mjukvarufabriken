import { useTranslation } from 'react-i18next'

import { usePageMeta } from '#/hooks/usePageMeta.ts'
import { LegalDocument } from '#/features/legal/LegalDocument.tsx'

import { Section } from '#/components/Section.tsx'

/** `/villkor` — Part A (terms of use) of `legal/villkor-webb.md` */
export function TermsPage() {
	const { t } = useTranslation()
	usePageMeta('meta.terms.title', 'meta.terms.description')

	return (
		<>
			<Section eyebrow={t('legal.eyebrow')} lead={t('legal.terms.lead')}>
				<h1>{t('legal.terms.title')}</h1>
			</Section>
			<LegalDocument part="terms" />
		</>
	)
}

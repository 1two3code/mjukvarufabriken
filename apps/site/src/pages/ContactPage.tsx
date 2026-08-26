import { useTranslation } from 'react-i18next'

import { contactEmail } from '#/app/site.ts'
import { usePageMeta } from '#/hooks/usePageMeta.ts'
import { ContactForm } from '#/features/contact/ContactForm.tsx'

import { Section } from '#/components/Section.tsx'

export function ContactPage() {
	const { t } = useTranslation()
	usePageMeta('meta.contact.title', 'meta.contact.description')

	return (
		<>
			<Section eyebrow={t('contact.eyebrow')} lead={t('contact.lead')}>
				<h1>{t('contact.title')}</h1>
			</Section>
			<Section variant="card">
				<ContactForm />
			</Section>
			<Section title={t('contact.direct.title')}>
				<p>
					{t('contact.direct.body')} <a href={`mailto:${contactEmail}`}>{contactEmail}</a>
				</p>
			</Section>
		</>
	)
}

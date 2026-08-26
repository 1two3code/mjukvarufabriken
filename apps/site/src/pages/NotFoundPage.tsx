import { useTranslation } from 'react-i18next'

import { usePageMeta } from '#/hooks/usePageMeta.ts'
import { useSiteRoute } from '#/hooks/useSiteRoute.ts'

import { ButtonLink } from '#/components/ButtonLink.tsx'
import { Section } from '#/components/Section.tsx'

export function NotFoundPage() {
	const { t } = useTranslation()
	const { pathTo } = useSiteRoute()
	usePageMeta('error.label.pageNotFound', 'error.body.pageNotFound')

	return (
		<Section lead={t('error.body.pageNotFound')}>
			<h1>{t('error.label.pageNotFound')}</h1>
			<div>
				<ButtonLink to={pathTo('home')} color="secondary">
					{t('error.action.home')}
				</ButtonLink>
			</div>
		</Section>
	)
}

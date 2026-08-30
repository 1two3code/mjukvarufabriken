import { useTranslation } from 'react-i18next'

export function NotFoundPage() {
	const { t } = useTranslation()

	return (
		<>
			<h1>{t('error.label.pageNotFound')}</h1>
			<p>{t('error.body.pageNotFound')}</p>
		</>
	)
}

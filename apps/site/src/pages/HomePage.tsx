import { useTranslation } from 'react-i18next'

import { ThemeToggle } from '#/features/theme/ThemeToggle.tsx'

export function HomePage() {
	const { t } = useTranslation()

	return (
		<>
			<h1>{t('page.home.title')}</h1>
			<p>{t('page.home.body')}</p>
			<ThemeToggle />
		</>
	)
}

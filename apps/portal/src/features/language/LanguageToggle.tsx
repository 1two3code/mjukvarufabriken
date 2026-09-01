import { useTranslation } from 'react-i18next'

import { nextLanguage, normalizeLanguage } from '#/app/language.ts'

import { Button } from '#/components/Button.tsx'

/** Cycles the interface language; the detector caches the choice for the next visit. */
export function LanguageToggle() {
	const { t, i18n } = useTranslation()
	const language = normalizeLanguage(i18n.language)

	return (
		<Button
			color="secondary"
			size="small"
			title={t('language.action.switch')}
			onClick={() => void i18n.changeLanguage(nextLanguage(language))}
		>
			{t(`language.${language}`)}
		</Button>
	)
}

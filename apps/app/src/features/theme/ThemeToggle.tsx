import ThemeIcon from '#/assets/icons/theme.svg?react'

import { useTranslation } from 'react-i18next'

import { useAppDispatch, useAppSelector } from '#/app/hooks.ts'
import { loadTheme, selectTheme, themes } from '#/features/theme/themeSlice.ts'

import { Button } from '#/components/Button.tsx'

export function ThemeToggle() {
	const { t } = useTranslation()
	const theme = useAppSelector(selectTheme)
	const dispatch = useAppDispatch()

	const cycleTheme = () => {
		const next = themes[(themes.indexOf(theme) + 1) % themes.length]
		dispatch(loadTheme(next))
	}

	return (
		<Button color="secondary" size="small" onClick={cycleTheme} title={t('theme.action.toggle')}>
			<ThemeIcon />
			{t(`theme.${theme}`)}
		</Button>
	)
}

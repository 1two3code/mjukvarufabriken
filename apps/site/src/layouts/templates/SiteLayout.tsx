import styles from './SiteLayout.module.css'

import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Outlet, ScrollRestoration } from 'react-router-dom'

import { useSiteRoute } from '#/hooks/useSiteRoute.ts'

import { Footer } from '#/layouts/footer/Footer.tsx'
import { Header } from '#/layouts/header/Header.tsx'

export function SiteLayout() {
	const { i18n } = useTranslation()
	const { language } = useSiteRoute()

	// The URL owns the language: keep i18next and the <html lang> attribute in sync with it
	useEffect(() => {
		document.documentElement.lang = language
		if (i18n.language !== language) i18n.changeLanguage(language)
	}, [i18n, language])

	return (
		<>
			<Header />
			<main className={styles.main}>
				<Outlet />
			</main>
			<Footer />
			<ScrollRestoration />
		</>
	)
}

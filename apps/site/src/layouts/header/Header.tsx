import styles from './Header.module.css'

import { useTranslation } from 'react-i18next'
import { Link, NavLink } from 'react-router-dom'

import { useSiteRoute } from '#/hooks/useSiteRoute.ts'
import { ThemeToggle } from '#/features/theme/ThemeToggle.tsx'

import { ButtonLink } from '#/components/ButtonLink.tsx'

import type { Page } from '#/app/routes.ts'

const navigationPages: Page[] = ['quote', 'howItWorks', 'demos', 'pricing', 'contact']

export function Header() {
	const { t } = useTranslation()
	const { language, pathTo, pathInLanguage } = useSiteRoute()
	const otherLanguage = language === 'sv' ? 'en' : 'sv'

	const linkClassName = ({ isActive }: { isActive: boolean }) =>
		[styles.link, isActive ? styles.active : ''].join(' ')

	return (
		<header className={styles.header}>
			<Link to={pathTo('home')} className={styles.brand}>
				{t('site.name')}
			</Link>
			<nav className={styles.navigation} aria-label={t('nav.label.main')}>
				{navigationPages.map(page => (
					<NavLink key={page} to={pathTo(page)} className={linkClassName}>
						{t(`nav.${page}`)}
					</NavLink>
				))}
			</nav>
			<div className={styles.right}>
				<Link
					to={pathInLanguage(otherLanguage)}
					className={styles.language}
					lang={otherLanguage}
					title={t('nav.action.switchLanguage')}
				>
					{t(`language.${otherLanguage}`)}
				</Link>
				<ThemeToggle />
				<ButtonLink href={import.meta.env.VITE_PORTAL_URL} size="small">
					{t('nav.action.portal')}
				</ButtonLink>
			</div>
		</header>
	)
}

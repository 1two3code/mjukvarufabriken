import styles from './Footer.module.css'

import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

import { contactEmail } from '#/app/site.ts'
import { useSiteRoute } from '#/hooks/useSiteRoute.ts'

export function Footer() {
	const { t } = useTranslation()
	const { pathTo } = useSiteRoute()

	return (
		<footer className={styles.footer}>
			<div className={styles.content}>
				<div className={styles.column}>
					<span className={styles.name}>{t('site.legalName')}</span>
					<span>{t('footer.orgNumber')}</span>
					<a href={`mailto:${contactEmail}`} className={styles.email}>
						{contactEmail}
					</a>
				</div>
				<nav className={styles.column} aria-label={t('nav.label.footer')}>
					<Link to={pathTo('howItWorks')}>{t('nav.howItWorks')}</Link>
					<Link to={pathTo('pricing')}>{t('nav.pricing')}</Link>
					<Link to={pathTo('contact')}>{t('nav.contact')}</Link>
					<a href={import.meta.env.VITE_PORTAL_URL}>{t('nav.action.portal')}</a>
				</nav>
			</div>
			<p className={styles.version}>
				{t('footer.copyright', { year: new Date().getFullYear() })} · v
				{import.meta.env.VITE_APP_VERSION}
			</p>
		</footer>
	)
}

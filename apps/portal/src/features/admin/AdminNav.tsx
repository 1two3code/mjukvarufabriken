import styles from './AdminNav.module.css'

import { useTranslation } from 'react-i18next'
import { NavLink } from 'react-router-dom'

const links = [
	{ to: '/admin', key: 'overview', end: true },
	{ to: '/admin/jobs', key: 'jobs', end: false },
	{ to: '/admin/customers', key: 'customers', end: false },
	{ to: '/admin/resident', key: 'resident', end: false },
	{ to: '/admin/pricing', key: 'pricing', end: false },
	// Margin (M12, per-customer + aggregate P&L): another tab here once it's built
] as const

/** Shared tab nav across every /admin/* section */
export function AdminNav() {
	const { t } = useTranslation()

	return (
		<nav className={styles.nav}>
			{links.map(link => (
				<NavLink
					key={link.to}
					to={link.to}
					end={link.end}
					className={({ isActive }) => [styles.link, isActive ? styles.active : ''].join(' ')}
				>
					{t(`admin.nav.${link.key}`)}
				</NavLink>
			))}
		</nav>
	)
}

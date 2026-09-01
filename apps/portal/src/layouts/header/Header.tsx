import styles from './Header.module.css'

import { useTranslation } from 'react-i18next'
import { NavLink } from 'react-router-dom'

import { useAppDispatch, useAppSelector } from '#/app/hooks.ts'
import { useLogoutMutation } from '#/features/auth/authApiSlice.ts'
import { clearSession, selectRefreshToken, selectSession } from '#/features/session/sessionSlice.ts'
import { LanguageToggle } from '#/features/language/LanguageToggle.tsx'
import { ThemeToggle } from '#/features/theme/ThemeToggle.tsx'

import { Has } from '#/layouts/Has.tsx'
import { HeaderLink } from '#/layouts/header/HeaderLink.tsx'
import { Button } from '#/components/Button.tsx'

export function Header() {
	const { t } = useTranslation()
	const dispatch = useAppDispatch()
	const session = useAppSelector(selectSession)
	const refreshToken = useAppSelector(selectRefreshToken)
	const [logout, { isLoading: isLoggingOut }] = useLogoutMutation()

	// Revoke the refresh token server-side first, then drop the local session either way
	const handleSignOut = async () => {
		if (refreshToken) await logout({ refreshToken })
		dispatch(clearSession())
	}

	return (
		<header className={styles.header}>
			<NavLink to="/" className={styles.brand}>
				{import.meta.env.VITE_APP_TITLE}
			</NavLink>
			<nav className={styles.navigation}>
				<HeaderLink label={t('page.home.title')} to="/" end />
				<Has permissions={['spec:read']}>
					<HeaderLink label={t('page.orders.title')} to="/orders" />
				</Has>
				<Has permissions={['job:admin']}>
					<HeaderLink label={t('page.admin.title')} to="/admin" />
				</Has>
			</nav>
			<div className={styles.right}>
				<LanguageToggle />
				<ThemeToggle />
				<span className={styles.user} title={session.user.email}>
					<span className={styles.userName}>{session.user.email}</span>
					<span className={styles.orgName}>{session.org.name}</span>
				</span>
				<Button color="secondary" size="small" onClick={handleSignOut} disabled={isLoggingOut}>
					{t('session.action.signOut')}
				</Button>
			</div>
		</header>
	)
}

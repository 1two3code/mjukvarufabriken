import styles from './AdminShowcasePage.module.css'

import { useTranslation } from 'react-i18next'
import { Navigate } from 'react-router-dom'

import { usePermission } from '#/hooks/usePermission.ts'
import { AdminNav } from '#/features/admin/AdminNav.tsx'
import { ShowcasePanel } from '#/features/admin/ShowcasePanel.tsx'

/** Admins only: which delivered orders the public site lists as demo apps (wave 14, F3) */
export function AdminShowcasePage() {
	const { t } = useTranslation()
	const { hasPermission } = usePermission()
	const isAdmin = hasPermission('job:admin')

	if (!isAdmin) return <Navigate to="/" replace />

	return (
		<>
			<h1>{t('page.adminShowcase.title')}</h1>
			<AdminNav />
			<p className={styles.intro}>{t('page.adminShowcase.intro')}</p>
			<ShowcasePanel />
		</>
	)
}

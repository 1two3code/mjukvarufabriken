import styles from './AdminCustomersPage.module.css'

import { useTranslation } from 'react-i18next'
import { Navigate } from 'react-router-dom'

import { usePermission } from '#/hooks/usePermission.ts'
import { AdminNav } from '#/features/admin/AdminNav.tsx'
import { CustomersTable } from '#/features/admin/CustomersTable.tsx'

/** Admins only: every customer org, its vended AWS account and lifecycle */
export function AdminCustomersPage() {
	const { t } = useTranslation()
	const { hasPermission } = usePermission()
	const isAdmin = hasPermission('job:admin')

	if (!isAdmin) return <Navigate to="/" replace />

	return (
		<>
			<h1>{t('page.adminCustomers.title')}</h1>
			<AdminNav />
			<p className={styles.intro}>{t('page.adminCustomers.intro')}</p>
			<CustomersTable />
		</>
	)
}

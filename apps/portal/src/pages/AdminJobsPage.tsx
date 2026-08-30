import styles from './AdminJobsPage.module.css'

import { useTranslation } from 'react-i18next'
import { Navigate } from 'react-router-dom'

import { usePermission } from '#/hooks/usePermission.ts'
import { useGetAdminJobsQuery } from '#/features/admin/adminApiSlice.ts'
import { AdminJobsTable } from '#/features/admin/AdminJobsTable.tsx'
import { AdminNav } from '#/features/admin/AdminNav.tsx'

const pollingInterval = 5000

/** Admins only: every build job across orgs, budgets and the kill switch */
export function AdminJobsPage() {
	const { t } = useTranslation()
	const { hasPermission } = usePermission()
	const isAdmin = hasPermission('job:admin')
	const {
		data: jobs = [],
		isLoading,
		isError,
	} = useGetAdminJobsQuery(undefined, { skip: !isAdmin, pollingInterval })

	if (!isAdmin) return <Navigate to="/" replace />

	return (
		<>
			<h1>{t('page.adminJobs.title')}</h1>
			<AdminNav />
			<p className={styles.intro}>{t('page.adminJobs.intro')}</p>
			<AdminJobsTable jobs={jobs} isLoading={isLoading} isError={isError} />
		</>
	)
}

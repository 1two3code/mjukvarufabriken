import styles from './AdminPage.module.css'

import { useTranslation } from 'react-i18next'
import { Navigate } from 'react-router-dom'

import { usePermission } from '#/hooks/usePermission.ts'
import { useGetAdminJobsQuery } from '#/features/admin/adminApiSlice.ts'
import { AdminJobsTable } from '#/features/admin/AdminJobsTable.tsx'
import { AdminTotals } from '#/features/admin/AdminTotals.tsx'

const pollingInterval = 5000

/** Admins only: every job across orgs, budgets and the kill switch */
export function AdminPage() {
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
			<h1>{t('page.admin.title')}</h1>
			<p className={styles.intro}>{t('page.admin.intro')}</p>
			<AdminTotals jobs={jobs} />
			<h2 className={styles.jobsTitle}>{t('page.admin.jobsTitle')}</h2>
			<AdminJobsTable jobs={jobs} isLoading={isLoading} isError={isError} />
		</>
	)
}

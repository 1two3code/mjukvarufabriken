import styles from './AdminOverviewPage.module.css'

import { useTranslation } from 'react-i18next'
import { Navigate } from 'react-router-dom'

import { usePermission } from '#/hooks/usePermission.ts'
import { useGetAdminJobsQuery } from '#/features/admin/adminApiSlice.ts'
import { AdminNav } from '#/features/admin/AdminNav.tsx'
import { AdminTotals } from '#/features/admin/AdminTotals.tsx'
import { DemoQueuePanel } from '#/features/admin/DemoQueuePanel.tsx'

const pollingInterval = 5000

/**
 * Admins only: totals across every build job — jobs today, active jobs, cost today and total —
 * and the demo queue (paid voucher demos waiting for a build approval, wave 14)
 */
export function AdminOverviewPage() {
	const { t } = useTranslation()
	const { hasPermission } = usePermission()
	const isAdmin = hasPermission('job:admin')
	const { data: jobs = [] } = useGetAdminJobsQuery(undefined, { skip: !isAdmin, pollingInterval })

	if (!isAdmin) return <Navigate to="/" replace />

	return (
		<>
			<h1>{t('page.admin.title')}</h1>
			<AdminNav />
			<p className={styles.intro}>{t('page.admin.intro')}</p>
			<AdminTotals jobs={jobs} />
			<DemoQueuePanel />
		</>
	)
}

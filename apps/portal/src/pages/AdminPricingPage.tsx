import styles from './AdminPricingPage.module.css'

import { useTranslation } from 'react-i18next'
import { Navigate } from 'react-router-dom'

import { usePermission } from '#/hooks/usePermission.ts'
import { AdminNav } from '#/features/admin/AdminNav.tsx'
import { ModelPricesPanel } from '#/features/admin/ModelPricesPanel.tsx'

/** Admins only: the append-only model price table (USD / MTok) */
export function AdminPricingPage() {
	const { t } = useTranslation()
	const { hasPermission } = usePermission()
	const isAdmin = hasPermission('job:admin')

	if (!isAdmin) return <Navigate to="/" replace />

	return (
		<>
			<h1>{t('page.adminPricing.title')}</h1>
			<AdminNav />
			<p className={styles.intro}>{t('page.adminPricing.intro')}</p>
			<ModelPricesPanel />
		</>
	)
}

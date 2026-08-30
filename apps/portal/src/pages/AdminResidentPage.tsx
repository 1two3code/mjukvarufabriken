import styles from './AdminResidentPage.module.css'

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate } from 'react-router-dom'

import { usePermission } from '#/hooks/usePermission.ts'
import { useToast } from '#/hooks/useToast.ts'
import { AdminNav } from '#/features/admin/AdminNav.tsx'
import {
	useBillResidentMonthMutation,
	useGetResidentInstallationsQuery,
	useGetResidentUsageQuery,
} from '#/features/admin/residentApiSlice.ts'
import {
	billingRunTone,
	filterUsageMonth,
	summarizeBillingRun,
	usageMonths,
} from '#/features/admin/residentBilling.ts'
import { ResidentInstallationsTable } from '#/features/admin/ResidentInstallationsTable.tsx'
import { ResidentUsageTable } from '#/features/admin/ResidentUsageTable.tsx'

import { Button } from '#/components/Button.tsx'

/** Admins only: resident installations, their metered usage per month and the billing run */
export function AdminResidentPage() {
	const { t } = useTranslation()
	const toast = useToast()
	const { hasPermission } = usePermission()
	const isAdmin = hasPermission('job:admin')
	const [month, setMonth] = useState('')
	// Every month in one fetch; the filter narrows client-side so the month list stays complete
	const usageQuery = useGetResidentUsageQuery({}, { skip: !isAdmin })
	const installationsQuery = useGetResidentInstallationsQuery(undefined, { skip: !isAdmin })
	const [bill, { isLoading: isBilling }] = useBillResidentMonthMutation()

	if (!isAdmin) return <Navigate to="/" replace />

	const usage = usageQuery.data ?? []
	const installations = installationsQuery.data ?? []
	const months = usageMonths(usage)
	const rows = filterUsageMonth(usage, month)
	const billMonth = month || months[0]

	const handleBill = async () => {
		if (!billMonth) return
		const result = await bill(billMonth)
		if (result.error) return
		const tone = billingRunTone(result.data)
		toast(
			tone,
			t(`resident.toast.${tone === 'success' ? 'billed' : 'billedNothing'}`, {
				month: billMonth,
				provider: result.data.provider,
				summary: summarizeBillingRun(result.data) || t('resident.toast.nothingToBill'),
			})
		)
	}

	return (
		<>
			<h1>{t('page.adminResident.title')}</h1>
			<AdminNav />
			<p className={styles.intro}>{t('page.adminResident.intro')}</p>

			<div className={styles.toolbar}>
				<label className={styles.filter}>
					<span>{t('resident.filter.month')}</span>
					<select
						className={styles.select}
						value={month}
						onChange={event => setMonth(event.target.value)}
					>
						<option value="">{t('resident.filter.allMonths')}</option>
						{months.map(value => (
							<option key={value} value={value}>
								{value}
							</option>
						))}
					</select>
				</label>
				<Button size="small" disabled={!billMonth || isBilling} onClick={handleBill}>
					{billMonth
						? t('resident.action.billMonth', { month: billMonth })
						: t('resident.action.billNothing')}
				</Button>
			</div>
			<p className={styles.hint}>{t('resident.billHint')}</p>

			<ResidentUsageTable
				usage={rows}
				installations={installations}
				isLoading={usageQuery.isLoading}
				isError={usageQuery.isError}
			/>

			<h2 className={styles.sectionTitle}>{t('page.adminResident.installationsTitle')}</h2>
			<p className={styles.hint}>{t('page.adminResident.installationsIntro')}</p>
			<ResidentInstallationsTable
				installations={installations}
				isLoading={installationsQuery.isLoading}
				isError={installationsQuery.isError}
			/>
		</>
	)
}

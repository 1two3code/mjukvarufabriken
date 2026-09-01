import styles from './AdminMarginPage.module.css'

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate } from 'react-router-dom'
import { allocateInfraCost } from '@mf/models'

import { usePermission } from '#/hooks/usePermission.ts'
import { useGetAdminJobsQuery, useGetAdminOrdersQuery, useGetAdminOrgsQuery } from '#/features/admin/adminApiSlice.ts'
import { customerMarginRows, defaultAssumptions, monthlyPnl } from '#/features/admin/margin.ts'
import { useGetMarginInfraCostQuery, useGetMarginRevenueQuery } from '#/features/admin/marginApiSlice.ts'
import { mockMarginData } from '#/features/admin/mockMargin.ts'
import { useGetResidentUsageQuery } from '#/features/admin/residentApiSlice.ts'
import { AdminNav } from '#/features/admin/AdminNav.tsx'
import { CustomerMarginTable } from '#/features/admin/CustomerMarginTable.tsx'
import { MarginAssumptionsPanel } from '#/features/admin/MarginAssumptionsPanel.tsx'
import { PnlTable } from '#/features/admin/PnlTable.tsx'

import type { MarginAssumptions } from '#/features/admin/margin.ts'

/**
 * Admins only: the M12 margin calculator — margin per customer and an aggregate P&L over time,
 * priced at the revenue model decided 2026-08-31. Cost comes from `jobs.cost_usd` (real per-job
 * spend), the phase-1 shared-infra allocation and resident list prices; revenue from paid build
 * fees, resident billing (list ×1.5) and the modeled 600 kr/mo managed subscription. Mock
 * customers keep the shape visible while no real orders exist.
 */
export function AdminMarginPage() {
	const { t } = useTranslation()
	const { hasPermission } = usePermission()
	const isAdmin = hasPermission('job:admin')

	const orgsQuery = useGetAdminOrgsQuery(undefined, { skip: !isAdmin })
	const jobsQuery = useGetAdminJobsQuery(undefined, { skip: !isAdmin })
	const ordersQuery = useGetAdminOrdersQuery(undefined, { skip: !isAdmin })
	const revenueQuery = useGetMarginRevenueQuery(undefined, { skip: !isAdmin })
	const infraQuery = useGetMarginInfraCostQuery(undefined, { skip: !isAdmin })
	const usageQuery = useGetResidentUsageQuery({}, { skip: !isAdmin })
	const queries = [orgsQuery, jobsQuery, ordersQuery, revenueQuery, infraQuery, usageQuery]

	// Mock customers by default until a real order or job exists; switchable either way
	const [showMock, setShowMock] = useState<boolean | null>(null)
	const hasRealData = (ordersQuery.data?.length ?? 0) > 0 || (jobsQuery.data?.length ?? 0) > 0
	const mock = showMock ?? !hasRealData

	const mockData = useMemo(() => mockMarginData(), [])
	const data = mock
		? mockData
		: {
				orgs: orgsQuery.data ?? [],
				jobs: jobsQuery.data ?? [],
				orders: ordersQuery.data ?? [],
				revenue: revenueQuery.data ?? [],
				usage: usageQuery.data ?? [],
				infra: infraQuery.data ?? allocateInfraCost([]),
			}

	const [overrides, setOverrides] = useState<Partial<MarginAssumptions>>({})
	const assumptions: MarginAssumptions = {
		...defaultAssumptions,
		infraPerOrgMonthlyUsd: data.infra.perOrgMonthlyCostUsd,
		...overrides,
	}

	const inputs = { ...data, assumptions }
	const customers = customerMarginRows(inputs)
	const pnl = monthlyPnl({ ...inputs, infraTotalMonthlyUsd: data.infra.totalMonthlyCostUsd })

	const state = mock
		? undefined
		: {
				loading: queries.some(query => query.isLoading),
				error: queries.some(query => query.isError) ? t('margin.loadError') : undefined,
			}

	if (!isAdmin) return <Navigate to="/" replace />

	return (
		<>
			<h1>{t('page.adminMargin.title')}</h1>
			<AdminNav />
			<p className={styles.intro}>{t('page.adminMargin.intro')}</p>
			<label className={styles.mockToggle}>
				<input
					type="checkbox"
					checked={mock}
					onChange={event => setShowMock(event.target.checked)}
				/>
				<span>{t('margin.mock.toggle')}</span>
			</label>
			{mock && <p className={styles.mockNote}>{t('margin.mock.note')}</p>}
			<MarginAssumptionsPanel
				assumptions={assumptions}
				onChange={(field, value) => setOverrides({ ...overrides, [field]: value })}
			/>
			<section className={styles.section}>
				<h2 className={styles.sectionTitle}>{t('margin.customer.title')}</h2>
				<CustomerMarginTable rows={customers} state={state} />
			</section>
			<section className={styles.section}>
				<h2 className={styles.sectionTitle}>{t('margin.pnl.title')}</h2>
				<PnlTable rows={pnl} state={state} />
			</section>
		</>
	)
}

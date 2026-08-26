import styles from './ResidentUsageTable.module.css'

import { useTranslation } from 'react-i18next'
import { residentUsageMarkup } from '@mf/models'

import { useGetAdminOrgsQuery } from '#/features/admin/adminApiSlice.ts'
import { formatTokens } from '#/features/admin/AdminTotals.tsx'
import { billingStatusOf, formatUsd } from '#/features/admin/residentBilling.ts'

import { Table } from '#/components/table/Table.tsx'

import type { ResidentInstallation, ResidentUsageSummary } from '@mf/models'
import type { ResidentBillingStatus } from '#/features/admin/residentBilling.ts'
import type { TableColumn } from '#/components/table/Table.tsx'

type ResidentUsageTableProps = {
	usage: ResidentUsageSummary[]
	installations: ResidentInstallation[]
	isLoading: boolean
	isError: boolean
}

type UsageRow = ResidentUsageSummary & {
	id: string
	status: ResidentBillingStatus
	unbilledUsdCents: number
}

const statusTone: Record<ResidentBillingStatus, string> = {
	nothing: styles.neutral,
	noCustomer: styles.caution,
	unreported: styles.caution,
	inProgress: styles.neutral,
	partial: styles.caution,
	reported: styles.success,
	overreported: styles.error,
}

/** One row per installation and month: tokens, list price, billable (× markup), billing state */
export function ResidentUsageTable({
	usage,
	installations,
	isLoading,
	isError,
}: ResidentUsageTableProps) {
	const { t, i18n } = useTranslation()
	const { data: orgs } = useGetAdminOrgsQuery()

	const orgName = (id?: string) => (id ? (orgs?.find(org => org.id === id)?.name ?? id) : '')
	const installationOf = (id: string) => installations.find(installation => installation.id === id)

	const rows: UsageRow[] = usage.map(row => ({
		...row,
		id: `${row.installationId}/${row.month}`,
		...billingStatusOf(row, installationOf(row.installationId)),
	}))

	const columns: TableColumn<UsageRow>[] = [
		{ header: t('resident.field.month'), field: 'month', sortable: true },
		{
			header: t('resident.field.installation'),
			field: 'installationId',
			sortable: true,
			cell: row => (
				<span className={styles.installation}>
					<span className={styles.repository}>{row.repository}</span>
					<span className={styles.secondary}>
						{orgName(row.orgId) || t('resident.unlinked')} · {row.installationId}
					</span>
				</span>
			),
		},
		{
			header: t('resident.field.tokens'),
			field: 'totalTokens',
			sortable: true,
			alignment: 'right',
			cell: row => (
				<span className={styles.tokens}>
					{formatTokens(row.totalTokens, i18n.language)}
					<span className={styles.secondary}>
						{t('resident.capUsed', {
							used: formatTokens(row.monthlyCap.usedTokens, i18n.language),
							cap: formatTokens(row.monthlyCap.tokens, i18n.language),
							days: row.days,
						})}
					</span>
				</span>
			),
		},
		{
			header: t('resident.field.listPrice'),
			field: 'listPriceUsd',
			sortable: true,
			alignment: 'right',
			cell: row => formatUsd(row.listPriceUsd, i18n.language),
		},
		{
			header: t('resident.field.billable', { markup: residentUsageMarkup }),
			field: 'billableUsd',
			sortable: true,
			alignment: 'right',
			cell: row => <strong>{formatUsd(row.billableUsd, i18n.language)}</strong>,
		},
		{
			header: t('resident.field.billing'),
			field: 'status',
			sortable: true,
			cell: row => (
				<span className={styles.billing}>
					<span className={[styles.status, statusTone[row.status]].join(' ')}>
						{t(`resident.billing.${row.status}`)}
					</span>
					{row.report && (
						<span className={styles.secondary}>
							{t('resident.reported', {
								amount: formatUsd(row.report.usdCents / 100, i18n.language),
								date: new Date(row.report.reportedAt).toLocaleDateString(i18n.language),
								provider: row.report.provider,
							})}
						</span>
					)}
					{row.unbilledUsdCents > 0 && row.status !== 'inProgress' && (
						<span className={styles.secondary}>
							{t('resident.unbilled', {
								amount: formatUsd(row.unbilledUsdCents / 100, i18n.language),
							})}
						</span>
					)}
				</span>
			),
		},
	]

	return (
		<Table
			columns={columns}
			rows={rows}
			state={{ loading: isLoading, error: isError ? t('resident.loadError') : undefined }}
		/>
	)
}

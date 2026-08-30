import styles from './AdminJobsTable.module.css'

import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { isActiveJobStatus, rawTokens } from '@mf/models'

import { useToast } from '#/hooks/useToast.ts'
import {
	useGetAdminOrdersQuery,
	useGetAdminOrgsQuery,
	useKillAdminJobMutation,
} from '#/features/admin/adminApiSlice.ts'
import { formatTokens } from '#/features/admin/AdminTotals.tsx'
import { formatUsd } from '#/features/admin/residentBilling.ts'

import { Button } from '#/components/Button.tsx'
import { Table } from '#/components/table/Table.tsx'

import type { Job } from '@mf/models'
import type { TableColumn } from '#/components/table/Table.tsx'

type AdminJobsTableProps = {
	jobs: Job[]
	isLoading: boolean
	isError: boolean
}

/** Every job across orgs with budget, org, order and the kill switch */
export function AdminJobsTable({ jobs, isLoading, isError }: AdminJobsTableProps) {
	const { t, i18n } = useTranslation()
	const toast = useToast()
	const { data: orders } = useGetAdminOrdersQuery()
	const { data: orgs } = useGetAdminOrgsQuery()
	const [kill, { isLoading: isKilling }] = useKillAdminJobMutation()

	const orgName = (id: string) => orgs?.find(org => org.id === id)?.name ?? id
	const orderName = (id: string) => orders?.find(order => order.id === id)?.name || id

	const handleKill = async (job: Job) => {
		const result = await kill(job.id)
		if (!result.error) toast('success', t('admin.toast.killed'))
	}

	const columns: TableColumn<Job>[] = [
		{
			header: t('admin.field.status'),
			field: 'status',
			sortable: true,
			cell: row => t(`job.status.${row.status}`),
		},
		{
			header: t('admin.field.org'),
			field: 'orgId',
			sortable: true,
			cell: row => orgName(row.orgId),
		},
		{
			header: t('admin.field.order'),
			field: 'orderId',
			sortable: true,
			cell: row => <Link to={`/orders/${row.orderId}/job`}>{orderName(row.orderId)}</Link>,
		},
		{
			header: t('admin.field.tokens'),
			field: 'tokensUsed',
			sortable: true,
			alignment: 'right',
			cell: row => (
				<span className={styles.tokens}>
					{formatTokens(row.tokensUsed, i18n.language)} /{' '}
					{formatTokens(row.budget.maxTokens, i18n.language)}
					<progress
						className={styles.progress}
						max={100}
						value={Math.min(100, Math.round((row.tokensUsed / row.budget.maxTokens) * 100))}
					/>
				</span>
			),
		},
		{
			header: t('admin.field.cost'),
			field: 'costUsd',
			sortable: true,
			alignment: 'right',
			// Real USD at the order's model prices; jobs from before migration 0018 have none
			cell: row =>
				row.costUsd === undefined ? (
					'–'
				) : (
					<span
						title={t('admin.field.costTitle', {
							tokens: formatTokens(row.usage ? rawTokens(row.usage) : 0, i18n.language),
						})}
					>
						{formatUsd(row.costUsd, i18n.language)}
					</span>
				),
		},
		{
			header: t('admin.field.created'),
			field: 'createdAt',
			sortable: true,
			cell: row => new Date(row.createdAt).toLocaleString(i18n.language),
		},
		{
			header: '',
			field: 'actions',
			alignment: 'right',
			cell: row =>
				isActiveJobStatus(row.status) && (
					<Button size="tiny" color="danger" disabled={isKilling} onClick={() => handleKill(row)}>
						{t('job.card.action.kill')}
					</Button>
				),
		},
	]

	return (
		<Table
			columns={columns}
			rows={jobs}
			state={{ loading: isLoading, error: isError ? t('admin.loadError') : undefined }}
		/>
	)
}

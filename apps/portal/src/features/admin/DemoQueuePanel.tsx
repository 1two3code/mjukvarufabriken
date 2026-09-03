import styles from './DemoQueuePanel.module.css'

import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

import { useToast } from '#/hooks/useToast.ts'
import {
	useApproveDemoBuildMutation,
	useGetAdminOrgsQuery,
	useGetDemoQueueQuery,
} from '#/features/admin/adminApiSlice.ts'

import { Button } from '#/components/Button.tsx'
import { Table } from '#/components/table/Table.tsx'

import type { Order } from '@mf/models'
import type { TableColumn } from '#/components/table/Table.tsx'

const pollingInterval = 10_000

/**
 * The demo queue (wave 14): paid voucher demos waiting for a human to approve the build, oldest
 * first, with the weekly cap. Approve starts the build at once; once the week is full the
 * button becomes "approve anyway" — a deliberate over-allocation, never the default.
 */
export function DemoQueuePanel() {
	const { t, i18n } = useTranslation()
	const toast = useToast()
	const { data, isLoading, isError } = useGetDemoQueueQuery(undefined, { pollingInterval })
	const { data: orgs } = useGetAdminOrgsQuery()
	const [approve, { isLoading: isApproving }] = useApproveDemoBuildMutation()

	const orgName = (id: string) => orgs?.find(org => org.id === id)?.name ?? id
	const capReached = data !== undefined && data.approvedThisWeek >= data.cap

	const handleApprove = async (order: Order) => {
		const result = await approve({ orderId: order.id, ...(capReached && { force: true }) })
		if (!result.error) toast('success', t('admin.demoQueue.toast.approved'))
	}

	const columns: TableColumn<Order>[] = [
		{
			header: t('admin.field.order'),
			field: 'name',
			sortable: true,
			cell: row => <Link to={`/orders/${row.id}`}>{row.name || row.id}</Link>,
		},
		{
			header: t('admin.field.org'),
			field: 'orgId',
			sortable: true,
			cell: row => orgName(row.orgId),
		},
		{
			header: t('order.field.sizeClass'),
			field: 'sizeClass',
			sortable: true,
			cell: row => row.sizeClass ?? '–',
		},
		{
			header: t('order.field.price'),
			field: 'priceSek',
			sortable: true,
			alignment: 'right',
			cell: row =>
				row.priceSek === undefined
					? '–'
					: t('order.priceValue', { price: row.priceSek.toLocaleString(i18n.language) }),
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
			cell: row => (
				<Button
					size="tiny"
					color={capReached ? 'danger' : 'primary'}
					disabled={isApproving}
					onClick={() => handleApprove(row)}
				>
					{t(capReached ? 'admin.demoQueue.action.force' : 'admin.demoQueue.action.approve')}
				</Button>
			),
		},
	]

	return (
		<section className={styles.panel}>
			<div className={styles.heading}>
				<h2 className={styles.title}>{t('admin.demoQueue.title')}</h2>
				{data && (
					<span className={[styles.cap, capReached ? styles.capReached : ''].join(' ')}>
						{t('admin.demoQueue.cap', { approved: data.approvedThisWeek, cap: data.cap })}
					</span>
				)}
			</div>
			<p className={styles.intro}>{t('admin.demoQueue.intro')}</p>
			{data?.orders.length === 0 ? (
				<p className={styles.empty}>{t('admin.demoQueue.empty')}</p>
			) : (
				<Table
					columns={columns}
					rows={data?.orders}
					state={{
						loading: isLoading,
						error: isError ? t('admin.demoQueue.loadError') : undefined,
					}}
				/>
			)}
		</section>
	)
}

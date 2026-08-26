import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'

import { useGetOrdersQuery } from '#/features/orders/ordersApiSlice.ts'
import { OrderStatusBadge } from '#/features/orders/OrderStatusBadge.tsx'

import { Table } from '#/components/table/Table.tsx'

import type { Order } from '@mf/models'
import type { TableColumn } from '#/components/table/Table.tsx'

export function OrderList() {
	const { t, i18n } = useTranslation()
	const navigate = useNavigate()
	const { data: orders, isLoading, isError } = useGetOrdersQuery()

	const columns: TableColumn<Order>[] = [
		{ header: t('order.field.name'), field: 'name', sortable: true },
		{
			header: t('order.field.status'),
			field: 'status',
			sortable: true,
			cell: row => <OrderStatusBadge status={row.status} />,
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
			header: t('order.field.created'),
			field: 'createdAt',
			sortable: true,
			cell: row => new Date(row.createdAt).toLocaleDateString(i18n.language),
		},
	]

	return (
		<Table
			columns={columns}
			rows={orders}
			state={{ loading: isLoading, error: isError ? t('order.list.loadError') : undefined }}
			onRowClick={row => navigate(`/orders/${row.id}`)}
		/>
	)
}

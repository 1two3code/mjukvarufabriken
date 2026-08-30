import { use } from 'react'
import { useTranslation } from 'react-i18next'

import { useToast } from '#/hooks/useToast.ts'
import { useGetItemsQuery, useUpdateItemMutation } from '#/features/items/itemsApiSlice.ts'
import { ItemsContext } from '#/features/items/itemsContext.ts'

import { Button } from '#/components/Button.tsx'
import { Table } from '#/components/table/Table.tsx'

import type { Item } from '@mf/models'
import type { TableColumn } from '#/components/table/Table.tsx'

export function ItemList() {
	const { t } = useTranslation()
	const toast = useToast()
	const { filters, selectedId, setSelectedId } = use(ItemsContext)
	const { data: items, isLoading, isError } = useGetItemsQuery(filters)
	const [updateItem] = useUpdateItemMutation()

	const archive = async (item: Item) => {
		const result = await updateItem({ id: item.id, status: 'archived' })
		if (!result.error) toast('success', t('item.toast.updated'))
	}

	const columns: TableColumn<Item>[] = [
		{ header: t('item.field.name'), field: 'name', sortable: true },
		{ header: t('item.field.description'), field: 'description' },
		{
			header: t('item.field.status'),
			field: 'status',
			cell: row => t(`item.status.${row.status}`),
		},
		{
			header: t('item.label.created'),
			field: 'createdAt',
			sortable: true,
			cell: row => new Date(row.createdAt).toLocaleDateString(),
		},
		{
			header: '',
			field: 'actions',
			alignment: 'right',
			cell: row =>
				row.status !== 'archived' && (
					<Button size="tiny" color="secondary" onClick={() => archive(row)}>
						{t('item.status.archived')}
					</Button>
				),
		},
	]

	return (
		<Table
			columns={columns}
			rows={items}
			selectedRowId={selectedId}
			state={{ loading: isLoading, error: isError ? t('common.label.noResults') : undefined }}
			onRowClick={row => setSelectedId(row.id === selectedId ? null : row.id)}
		/>
	)
}

import styles from './TableBody.module.css'

import { useTranslation } from 'react-i18next'

import { Spinner } from '#/components/Spinner.tsx'

import type { TableColumn } from '#/components/table/Table.tsx'

type TableBodyProps<T extends { id: string }> = {
	columns: TableColumn<T>[]
	rows: T[]
	selectedRowId?: string | null
	isLoading?: boolean
	dataError?: string
	onRowClick?: (row: T) => void
}

const renderCell = <T,>(column: TableColumn<T>, row: T) => {
	if (column.cell) return column.cell(row)
	return (row as Record<string, unknown>)[column.field] as React.ReactNode
}

export function TableBody<T extends { id: string }>({
	columns,
	rows,
	selectedRowId,
	isLoading = false,
	dataError,
	onRowClick,
}: TableBodyProps<T>) {
	const { t } = useTranslation()

	const showOverlay = !rows.length || isLoading || !!dataError

	const getRowClassNames = (row: T) => {
		const classNames = [styles.row]
		if (onRowClick) classNames.push(styles.clickableRow)
		if (row.id === selectedRowId) classNames.push(styles.selectedRow)
		return classNames
	}

	return (
		<tbody className={styles.body}>
			{rows.map(row => (
				<tr
					key={row.id}
					className={getRowClassNames(row).join(' ')}
					onClick={() => onRowClick?.(row)}
				>
					{columns.map(column => (
						<td
							key={column.field}
							className={`${styles.cell} ${styles[column.alignment ?? 'left']}`}
							style={{ ...(column.maxWidth && { maxWidth: column.maxWidth }) }}
						>
							{renderCell(column, row)}
						</td>
					))}
				</tr>
			))}
			{showOverlay && (
				<tr className={styles.overlay}>
					<td className={styles.overlayCell} colSpan={columns.length}>
						{isLoading ? <Spinner center /> : (dataError ?? t('common.label.noResults'))}
					</td>
				</tr>
			)}
		</tbody>
	)
}

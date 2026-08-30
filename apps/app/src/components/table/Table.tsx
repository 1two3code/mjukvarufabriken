import styles from './Table.module.css'

import { useState } from 'react'

import { TableBody } from '#/components/table/TableBody.tsx'
import { TableHead } from '#/components/table/TableHead.tsx'

export type SortDirection = 'asc' | 'desc'

export type TableSorting<T> = { field: keyof T & string; direction: SortDirection }

export type TableColumn<T> = {
	header: React.ReactNode
	/** Property to read from the row, or a virtual field name when `cell` is provided */
	field: (keyof T & string) | (string & NonNullable<unknown>)
	cell?: (row: T) => React.ReactNode
	sortable?: boolean
	alignment?: 'left' | 'center' | 'right'
	maxWidth?: `${string}rem`
}

type TableProps<T extends { id: string }> = {
	className?: string
	columns: TableColumn<T>[]
	rows?: T[]
	selectedRowId?: string | null
	state?: { loading?: boolean; error?: string }
	onRowClick?: (row: T) => void
}

const compare = (a: unknown, b: unknown) => {
	if (typeof a === 'number' && typeof b === 'number') return a - b
	return String(a ?? '').localeCompare(String(b ?? ''))
}

const sortRows = <T,>(rows: T[], sorting: TableSorting<T> | null) => {
	if (!sorting) return rows
	const factor = sorting.direction === 'asc' ? 1 : -1
	return rows.toSorted((a, b) => factor * compare(a[sorting.field], b[sorting.field]))
}

export function Table<T extends { id: string }>({
	className,
	columns,
	rows = [],
	selectedRowId,
	state,
	onRowClick,
}: TableProps<T>) {
	const [sorting, setSorting] = useState<TableSorting<T> | null>(null)

	const handleSort = (field: keyof T & string) => {
		const direction = sorting?.field === field && sorting.direction === 'asc' ? 'desc' : 'asc'
		setSorting({ field, direction })
	}

	const classNames = [styles.table]
	if (className) classNames.push(className)

	return (
		<div className={styles.scrollArea}>
			<table className={classNames.join(' ')}>
				<TableHead columns={columns} sorting={sorting} onSort={handleSort} />
				<TableBody
					columns={columns}
					rows={sortRows(rows, sorting)}
					selectedRowId={selectedRowId}
					isLoading={state?.loading}
					dataError={state?.error}
					onRowClick={onRowClick}
				/>
			</table>
		</div>
	)
}

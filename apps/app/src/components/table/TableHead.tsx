import styles from './TableHead.module.css'
import ArrowUpIcon from '#/assets/icons/arrow-up.svg?react'

import type { TableColumn, TableSorting } from '#/components/table/Table.tsx'

type TableHeadProps<T> = {
	columns: TableColumn<T>[]
	sorting: TableSorting<T> | null
	onSort: (field: keyof T & string) => void
}

const getColumnClassNames = <T,>(column: TableColumn<T>, sorting: TableSorting<T> | null) => {
	const classNames = [styles.column, styles[column.alignment ?? 'left']]
	if (column.sortable) classNames.push(styles.sortable)
	if (sorting?.field === column.field) classNames.push(styles[`${sorting.direction}Sort`])
	return classNames
}

export function TableHead<T>({ columns, sorting, onSort }: TableHeadProps<T>) {
	return (
		<thead className={styles.head}>
			<tr>
				{columns.map(column => (
					<th
						key={column.field}
						className={getColumnClassNames(column, sorting).join(' ')}
						style={{ ...(column.maxWidth && { maxWidth: column.maxWidth }) }}
						onClick={() => column.sortable && onSort(column.field as keyof T & string)}
					>
						<span>{column.header}</span>
						{column.sortable && <ArrowUpIcon className={styles.sortIcon} />}
					</th>
				))}
			</tr>
		</thead>
	)
}

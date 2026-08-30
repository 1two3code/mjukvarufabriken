import styles from './ItemsFilter.module.css'

import { use } from 'react'
import { useTranslation } from 'react-i18next'
import { itemStatus } from '@template/models'

import { ItemsContext } from '#/features/items/itemsContext.ts'

import { Input } from '#/components/Input.tsx'

import type { ItemStatus } from '@template/models'

export function ItemsFilter() {
	const { t } = useTranslation()
	const { filters, setFilters } = use(ItemsContext)

	const handleStatusChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
		const status = event.target.value as ItemStatus | ''
		setFilters({ ...filters, status: status || undefined })
	}

	return (
		<div className={styles.filter}>
			<Input
				label={t('item.field.name')}
				name="search"
				value={filters.search ?? ''}
				onChange={search => setFilters({ ...filters, search: search || undefined })}
			/>
			<label className={styles.select}>
				<span className={styles.label}>{t('item.field.status')}</span>
				<select
					className={styles.selectElement}
					value={filters.status ?? ''}
					onChange={handleStatusChange}
				>
					<option value="">{t('item.status.all')}</option>
					{itemStatus.map(status => (
						<option key={status} value={status}>
							{t(`item.status.${status}`)}
						</option>
					))}
				</select>
			</label>
		</div>
	)
}

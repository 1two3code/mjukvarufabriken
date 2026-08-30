import styles from './ItemsPage.module.css'

import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { defaultItemsFilters, ItemsContext } from '#/features/items/itemsContext.ts'
import { ItemForm } from '#/features/items/ItemForm.tsx'
import { ItemList } from '#/features/items/ItemList.tsx'
import { ItemsFilter } from '#/features/items/ItemsFilter.tsx'

import { Has } from '#/layouts/Has.tsx'

import type { ItemsFilters } from '#/features/items/itemsContext.ts'

export function ItemsPage() {
	const { t } = useTranslation()
	const [filters, setFilters] = useState<ItemsFilters>(defaultItemsFilters)
	const [selectedId, setSelectedId] = useState<string | null>(null)

	return (
		<ItemsContext value={{ filters, setFilters, selectedId, setSelectedId }}>
			<h1>{t('page.items.title')}</h1>
			<div className={styles.toolbar}>
				<ItemsFilter />
				<Has permissions={['item:write']}>
					<ItemForm />
				</Has>
			</div>
			<ItemList />
		</ItemsContext>
	)
}

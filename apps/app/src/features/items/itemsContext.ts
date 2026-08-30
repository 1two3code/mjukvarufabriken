import { createContext } from 'react'

import type { ItemQuery } from '@template/models'

export type ItemsFilters = ItemQuery['GetItems']

export const defaultItemsFilters: ItemsFilters = {}

/**
 * Feature-local UI state for the items feature (filters and selection).
 */
export const ItemsContext = createContext<{
	filters: ItemsFilters
	setFilters: (filters: ItemsFilters) => void
	selectedId: string | null
	setSelectedId: (id: string | null) => void
}>({
	filters: defaultItemsFilters,
	setFilters: () => {},
	selectedId: null,
	setSelectedId: () => {},
})

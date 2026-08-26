import { ItemSchema } from './Item.ts'

import type { Item } from './Item.ts'

export const isItem = (value: unknown): value is Item => {
	return ItemSchema.safeParse(value).success
}

export const isArchivedItem = (value: unknown): value is Item & { status: 'archived' } => {
	return isItem(value) && value.status === 'archived'
}

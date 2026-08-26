import { z } from 'zod'

import { ItemSchema } from './Item.ts'

// MARK: Mutations
export const ItemMutationSchemas = {
	CreateItem: ItemSchema.omit({ id: true, createdAt: true, status: true }).strict(),
	UpdateItem: ItemSchema.pick({ name: true, description: true, status: true }).partial().strict(),
}

export type ItemMutation = {
	CreateItem: z.infer<typeof ItemMutationSchemas.CreateItem>
	UpdateItem: z.infer<typeof ItemMutationSchemas.UpdateItem>
}

// MARK: Queries
export const ItemQuerySchemas = {
	GetItems: z.object({
		status: ItemSchema.shape.status.optional(),
		search: z.string().optional(),
	}),
}

export type ItemQuery = {
	GetItems: z.infer<typeof ItemQuerySchemas.GetItems>
}

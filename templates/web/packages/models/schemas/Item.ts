import { z } from 'zod'

export const itemStatus = ['draft', 'active', 'archived'] as const

export type ItemStatus = (typeof itemStatus)[number]

export const ItemSchema = z.object({
	id: z.string(),
	name: z.string().min(1),
	description: z.string().optional(),
	status: z.enum(itemStatus),
	createdAt: z.iso.datetime(),
})

export type Item = z.infer<typeof ItemSchema>

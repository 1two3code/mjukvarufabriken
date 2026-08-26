import { z } from 'zod'

import { RoleSchema } from './Role.ts'

export const UserSchema = z.object({
	id: z.string(),
	email: z.email(),
	name: z.string().optional(),
	role: RoleSchema,
	orgId: z.string(),
	createdAt: z.iso.datetime(),
})

export type User = z.infer<typeof UserSchema>

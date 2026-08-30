import { z } from 'zod'
import { role } from '@template/access-control'

/**
 * The session decorated on every authenticated API request.
 */
export type BackendSession = { userId: string; role: z.infer<typeof RoleSchema> }

export const RoleSchema = z.enum(role)

export const FrontendSessionSchema = z.object({
	userId: z.string(),
	name: z.string(),
	role: RoleSchema,
})

export type FrontendSession = z.infer<typeof FrontendSessionSchema>

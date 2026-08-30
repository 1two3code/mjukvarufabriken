import { z } from 'zod'

import { OrgSchema } from './Org.ts'
import { RoleSchema } from './Role.ts'
import { UserSchema } from './User.ts'

/**
 * The session decorated on every authenticated API request.
 */
export type BackendSession = { userId: string; role: z.infer<typeof RoleSchema>; orgId: string }

export const FrontendSessionSchema = z.object({
	userId: z.string(),
	/** Display name: the user's name when set, otherwise the email */
	name: z.string(),
	role: RoleSchema,
	user: UserSchema,
	org: OrgSchema,
})

export type FrontendSession = z.infer<typeof FrontendSessionSchema>

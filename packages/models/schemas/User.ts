import { z } from 'zod'

import { RoleSchema } from './Role.ts'

export const UserSchema = z.object({
	id: z.string(),
	email: z.email(),
	name: z.string().optional(),
	role: RoleSchema,
	orgId: z.string(),
	/** GitHub account id (stable) once the user signed in with GitHub or linked the account */
	githubId: z.string().optional(),
	/** GitHub login at the time of the last GitHub sign-in (may be renamed on GitHub) */
	githubLogin: z.string().optional(),
	createdAt: z.iso.datetime(),
})

export type User = z.infer<typeof UserSchema>

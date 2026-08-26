import { z } from 'zod'

/**
 * A customer organisation. Every user belongs to exactly one org; the first user signing in
 * from a new email domain creates it (see the api `userService`).
 */
export const OrgSchema = z.object({
	id: z.string(),
	name: z.string().min(1),
	createdAt: z.iso.datetime(),
})

export type Org = z.infer<typeof OrgSchema>

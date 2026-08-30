import { z } from 'zod'

import { UserSchema } from './User.ts'

// MARK: Mutations
export const AuthMutationSchemas = {
	RequestMagicLink: z.object({ email: UserSchema.shape.email }).strict(),
	VerifyMagicLink: z.object({ token: z.string().min(1) }).strict(),
	Refresh: z.object({ refreshToken: z.string().min(1) }).strict(),
	Logout: z.object({ refreshToken: z.string().min(1) }).strict(),
}

export type AuthMutation = {
	RequestMagicLink: z.infer<typeof AuthMutationSchemas.RequestMagicLink>
	VerifyMagicLink: z.infer<typeof AuthMutationSchemas.VerifyMagicLink>
	Refresh: z.infer<typeof AuthMutationSchemas.Refresh>
	Logout: z.infer<typeof AuthMutationSchemas.Logout>
}

// MARK: Custom responses
/** Access JWT (short-lived) + opaque refresh token (long-lived, rotated on every refresh) */
export const TokenPairSchema = z.object({
	token: z.string(),
	refreshToken: z.string(),
})

export type TokenPair = z.infer<typeof TokenPairSchema>

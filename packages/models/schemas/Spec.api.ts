import { z } from 'zod'

import { SpecDraftSchema } from './Spec.ts'

// MARK: Mutations
export const SpecMutationSchemas = {
	PostSpecMessage: z.object({ content: z.string().trim().min(1).max(8000) }).strict(),
}

export type SpecMutation = {
	PostSpecMessage: z.infer<typeof SpecMutationSchemas.PostSpecMessage>
}

// MARK: Operations
export const SpecOperationSchemas = {
	/** Freezing takes no input — the draft must already pass `isSpecComplete` */
	FreezeSpec: z.object({}).strict().optional(),
}

// MARK: Custom responses
/** Every spec route returns the full draft so the portal can replace its cache in one go */
export const SpecDraftResponseSchema = SpecDraftSchema

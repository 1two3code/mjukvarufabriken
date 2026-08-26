import { z } from 'zod'

// MARK: Enums
export const sizeClass = ['S', 'M', 'L'] as const
export type SizeClass = (typeof sizeClass)[number]

export const specStatus = ['drafting', 'ready', 'frozen'] as const
export type SpecStatus = (typeof specStatus)[number]

export const chatRole = ['user', 'assistant'] as const
export type ChatRole = (typeof chatRole)[number]

// MARK: Spec
export const SpecFeatureSchema = z.object({
	title: z.string().min(1),
	description: z.string(),
	acceptanceCriteria: z.array(z.string().min(1)),
})
export type SpecFeature = z.infer<typeof SpecFeatureSchema>

/**
 * The structured spec a build job is started from. `sizeClass` is set by the price
 * estimator once the spec is complete.
 */
export const SpecSchema = z.object({
	goal: z.string(),
	users: z.array(z.string()),
	features: z.array(SpecFeatureSchema),
	nonGoals: z.array(z.string()),
	stackConstraints: z.array(z.string()),
	sizeClass: z.enum(sizeClass).optional(),
})
export type Spec = z.infer<typeof SpecSchema>

/** A spec while it is still being drafted — every field may be missing. */
export const PartialSpecSchema = SpecSchema.partial()
export type PartialSpec = z.infer<typeof PartialSpecSchema>

// MARK: Chat
export const ChatMessageSchema = z.object({
	role: z.enum(chatRole),
	content: z.string(),
	createdAt: z.iso.datetime(),
})
export type ChatMessage = z.infer<typeof ChatMessageSchema>

// MARK: Draft
export const SpecDraftSchema = z.object({
	orderId: z.string(),
	status: z.enum(specStatus),
	spec: PartialSpecSchema,
	messages: z.array(ChatMessageSchema),
	openQuestions: z.array(z.string()),
	/** Fixed price in SEK ex moms, set once the spec is complete */
	priceSek: z.number().int().nonnegative().optional(),
	frozenAt: z.iso.datetime().optional(),
})
export type SpecDraft = z.infer<typeof SpecDraftSchema>

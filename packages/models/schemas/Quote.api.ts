import { z } from 'zod'

import { OrderSchema } from './Order.ts'
import { SpecMutationSchemas } from './Spec.api.ts'
import { ChatMessageSchema, PartialSpecSchema, sizeClass, specStatus } from './Spec.ts'

/**
 * The anonymous quote (wave 14, F1): a spec chat on the public site with no account. The site
 * proves it owns a quote with the token `POST /bff/quote` returned once, sent as the
 * `x-quote-token` header (64 hex chars — 32 random bytes; the api stores only its sha256).
 */
export const quoteTokenHeader = 'x-quote-token'
export const QuoteTokenSchema = z.string().regex(/^[0-9a-f]{64}$/)

// MARK: Mutations
export const QuoteMutationSchemas = {
	/** The order's customer-facing name once claimed; the site passes its localized default */
	CreateQuote: z.object({ name: z.string().trim().min(1).max(120).optional() }).strict(),
	PostQuoteMessage: SpecMutationSchemas.PostSpecMessage,
	/** Claims the quote for the signed-in session (`POST /bff/orders/claim`) */
	ClaimQuote: z.object({ orderId: z.string().min(1).max(200), token: QuoteTokenSchema }).strict(),
}

export type QuoteMutation = {
	CreateQuote: z.infer<typeof QuoteMutationSchemas.CreateQuote>
	PostQuoteMessage: z.infer<typeof QuoteMutationSchemas.PostQuoteMessage>
	ClaimQuote: z.infer<typeof QuoteMutationSchemas.ClaimQuote>
}

// MARK: Custom responses
/**
 * What the site sees of an anonymous draft: the conversation, the structured spec so far, and —
 * once the spec is complete — the fixed quote the engine computed on that turn. Never the org
 * (there is none) and never the token hash.
 */
export const QuoteSchema = z.object({
	orderId: z.string(),
	status: z.enum(specStatus),
	spec: PartialSpecSchema,
	messages: z.array(ChatMessageSchema),
	openQuestions: z.array(z.string()),
	/** True when the spec passes `isSpecComplete` — the quote below is then fixed */
	complete: z.boolean(),
	/** Fixed price in SEK ex moms; present only while `complete` */
	priceSek: z.number().int().nonnegative().optional(),
	sizeClass: z.enum(sizeClass).optional(),
})
export type Quote = z.infer<typeof QuoteSchema>

export const QuoteResponseSchema = QuoteSchema

/** `POST /bff/quote`: the only time the token is ever returned */
export const CreateQuoteResponseSchema = z.object({
	quote: QuoteSchema,
	token: QuoteTokenSchema,
})
export type CreateQuoteResponse = z.infer<typeof CreateQuoteResponseSchema>

export const ClaimQuoteResponseSchema = OrderSchema

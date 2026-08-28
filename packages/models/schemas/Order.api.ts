import { z } from 'zod'

import { JobSchema } from './Job.ts'
import { OrderSchema } from './Order.ts'
import { paymentKind, PaymentSchema } from './Payment.ts'
import { specStatus } from './Spec.ts'

// MARK: Mutations
export const OrderMutationSchemas = {
	CreateOrder: z.object({ name: z.string().trim().min(1).max(120) }).strict(),
	/** Admin toggle of the per-order approve-before-deliver gate (W7) */
	SetApprovalGate: z.object({ enabled: z.boolean() }).strict(),
}

export type OrderMutation = {
	CreateOrder: z.infer<typeof OrderMutationSchemas.CreateOrder>
	SetApprovalGate: z.infer<typeof OrderMutationSchemas.SetApprovalGate>
}

// MARK: Operations
export const OrderOperationSchemas = {
	Checkout: z.object({ kind: z.enum(paymentKind) }).strict(),
}

export type OrderOperation = {
	Checkout: z.infer<typeof OrderOperationSchemas.Checkout>
}

// MARK: Custom responses
/** What the order page needs of the latest job without the full spec/plan */
export const JobSummarySchema = JobSchema.pick({
	id: true,
	status: true,
	tokensUsed: true,
	budget: true,
	startedAt: true,
	finishedAt: true,
	createdAt: true,
})
export type JobSummary = z.infer<typeof JobSummarySchema>

export const OrderDetailSchema = z.object({
	order: OrderSchema,
	spec: z.object({
		status: z.enum(specStatus),
		/** True when the spec passes `isSpecComplete` (can be frozen) */
		complete: z.boolean(),
		openQuestions: z.number().int().nonnegative(),
	}),
	latestJob: JobSummarySchema.optional(),
	payments: z.array(PaymentSchema),
})
export type OrderDetail = z.infer<typeof OrderDetailSchema>

export const OrderResponseSchema = OrderSchema
export const OrderListResponseSchema = z.array(OrderSchema)
export const OrderDetailResponseSchema = OrderDetailSchema

export const CheckoutResponseSchema = z.object({
	payment: PaymentSchema,
	/** Where to send the browser: Stripe Checkout, or the fake provider's local page */
	url: z.string(),
})
export type CheckoutResponse = z.infer<typeof CheckoutResponseSchema>

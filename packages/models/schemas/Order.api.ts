import { z } from 'zod'

import { JobSchema } from './Job.ts'
import { lifecycleActions, LifecycleStateSchema } from './Lifecycle.ts'
import { orderKind, OrderSchema } from './Order.ts'
import { OrgSchema } from './Org.ts'
import { paymentKind, PaymentSchema } from './Payment.ts'
import { specStatus } from './Spec.ts'

// MARK: Mutations
export const OrderMutationSchemas = {
	/** `kind` picks the pricing-ladder rung (wave 14); omitted = a real `build` */
	CreateOrder: z
		.object({
			name: z.string().trim().min(1).max(120),
			kind: z.enum(orderKind).default('build'),
		})
		.strict(),
	/** Admin toggle of the per-order approve-before-deliver gate (W7) */
	SetApprovalGate: z.object({ enabled: z.boolean() }).strict(),
	/**
	 * Admin deprovisioning action on an order's delivery (wave 9). `confirm` is the dry-run guard:
	 * omitted / false previews the deprovision and leaves the lifecycle untouched, `true` performs
	 * it and writes the new state.
	 */
	LifecycleAction: z
		.object({ action: z.enum(lifecycleActions), confirm: z.boolean().optional() })
		.strict(),
}

export type OrderMutation = {
	/** The input side: a client may leave `kind` out and get the `build` default */
	CreateOrder: z.input<typeof OrderMutationSchemas.CreateOrder>
	SetApprovalGate: z.infer<typeof OrderMutationSchemas.SetApprovalGate>
	LifecycleAction: z.infer<typeof OrderMutationSchemas.LifecycleAction>
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

// MARK: Lifecycle / deprovisioning (wave 9)

/** The audited outcome of a deprovision run, trimmed to what the admin UI needs. */
export const DeprovisionSummarySchema = z.object({
	mode: z.enum(lifecycleActions),
	dryRun: z.boolean(),
	/** Everything discovery returned. */
	discovered: z.number().int().nonnegative(),
	/** How many carried the `Service=mf-delivery` fence and were acted on. */
	fenced: z.number().int().nonnegative(),
	/** Discovered resources dropped for lacking the fence tag. */
	skippedByFence: z.number().int().nonnegative(),
	/** Per-outcome counts (`planned`, `deleted`, `already-gone`, …). */
	summary: z.record(z.string(), z.number().int().nonnegative()),
})
export type DeprovisionSummary = z.infer<typeof DeprovisionSummarySchema>

/** Response of the admin lifecycle action: the order after the action + the deprovision summary. */
export const LifecycleActionResponseSchema = z.object({
	action: z.enum(lifecycleActions),
	/** True for the default preview run — nothing was torn down and the state did not change. */
	dryRun: z.boolean(),
	from: LifecycleStateSchema,
	to: LifecycleStateSchema,
	/** True when the DB lifecycle state was actually written (a confirmed, non-idempotent move). */
	applied: z.boolean(),
	order: OrderSchema,
	/** Absent when the order has no delivery to deprovision. */
	deprovision: DeprovisionSummarySchema.optional(),
})
export type LifecycleActionResponse = z.infer<typeof LifecycleActionResponseSchema>

/** Response of the onboarding account-provisioning step. */
export const ProvisionAccountResponseSchema = z.object({
	/** True when the step did nothing (flag off, or an account was already recorded). */
	skipped: z.boolean(),
	reason: z.string().optional(),
	org: OrgSchema,
	accountId: z.string().optional(),
	reused: z.boolean().optional(),
})
export type ProvisionAccountResponse = z.infer<typeof ProvisionAccountResponseSchema>

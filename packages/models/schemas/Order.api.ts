import { z } from 'zod'

import { JobSchema } from './Job.ts'
import { lifecycleActions, LifecycleStateSchema } from './Lifecycle.ts'
import { orderKind, OrderSchema } from './Order.ts'
import { PreviewTeardownReportSchema } from './OrderExport.ts'
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
	 * it and writes the new state. A confirmed `teardown` is refused until the order's final export
	 * is `done` (wave 14) unless `skipExport` says the admin knows there is nothing to keep.
	 */
	LifecycleAction: z
		.object({
			action: z.enum(lifecycleActions),
			confirm: z.boolean().optional(),
			skipExport: z.boolean().optional(),
		})
		.strict(),
	/**
	 * Admin approval of a demo order's build (wave 14): the paid demo starts building. `force`
	 * bypasses the weekly voucher cap (a deliberate over-allocation, never the default).
	 */
	ApproveBuild: z.object({ force: z.boolean().optional() }).strict(),
	/**
	 * Admin override of the included hosting window (wave 14): a new end instant extends or
	 * shortens it, `null` clears the scheduled end so the sweep never picks the order up.
	 */
	SetHostingUntil: z.object({ hostingUntil: z.iso.datetime().nullable() }).strict(),
}

export type OrderMutation = {
	/** The input side: a client may leave `kind` out and get the `build` default */
	CreateOrder: z.input<typeof OrderMutationSchemas.CreateOrder>
	SetApprovalGate: z.infer<typeof OrderMutationSchemas.SetApprovalGate>
	LifecycleAction: z.infer<typeof OrderMutationSchemas.LifecycleAction>
	ApproveBuild: z.infer<typeof OrderMutationSchemas.ApproveBuild>
	SetHostingUntil: z.infer<typeof OrderMutationSchemas.SetHostingUntil>
}

// MARK: Operations
export const OrderOperationSchemas = {
	Checkout: z.object({ kind: z.enum(paymentKind) }).strict(),
}

export type OrderOperation = {
	Checkout: z.infer<typeof OrderOperationSchemas.Checkout>
}

// MARK: Custom responses
/** What the order page needs of a job without the full spec/plan/gates */
export const JobSummarySchema = JobSchema.pick({
	id: true,
	status: true,
	mode: true,
	sourceJobId: true,
	reason: true,
	tokensUsed: true,
	budget: true,
	startedAt: true,
	finishedAt: true,
	createdAt: true,
})
export type JobSummary = z.infer<typeof JobSummarySchema>

/**
 * Whether the customer actually got a hosted app (wave 14, F7). `live`: the latest delivered job
 * carries a preview URL. `unhosted`: a job delivered its repository + bundle but the preview URL
 * was withheld (deploy skipped/failed or the live acceptance check failed) — the order is still
 * `delivered` by the repo contract, but the portal must not call it live, and a full-upfront
 * order does not auto-close as `paid`. `none`: nothing delivered yet.
 */
export const hostingStatus = ['live', 'unhosted', 'none'] as const
export type HostingStatus = (typeof hostingStatus)[number]

export const OrderHostingSchema = z.object({
	status: z.enum(hostingStatus),
	/** The live preview URL when `status` is `live`, otherwise null */
	deployUrl: z.string().nullable(),
	/** Why the URL was withheld when `status` is `unhosted` (the job's reason, else the failed deploy/acceptance step's), otherwise null */
	reason: z.string().nullable(),
})
export type OrderHosting = z.infer<typeof OrderHostingSchema>

export const OrderDetailSchema = z.object({
	order: OrderSchema,
	spec: z.object({
		status: z.enum(specStatus),
		/** True when the spec passes `isSpecComplete` (can be frozen) */
		complete: z.boolean(),
		openQuestions: z.number().int().nonnegative(),
	}),
	/** The newest job of the order (`jobs[0]`), kept for the order page's summary line */
	latestJob: JobSummarySchema.optional(),
	/** Every job of the order, newest first — builds, auto-retries and redeliveries */
	jobs: z.array(JobSummarySchema),
	hosting: OrderHostingSchema,
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

/**
 * The admin's demo queue (wave 14): paid demo orders waiting for a build approval, oldest first,
 * with the weekly voucher cap and how much of it is used.
 */
export const DemoQueueResponseSchema = z.object({
	orders: z.array(OrderSchema),
	/** Demo builds approved in the last seven days (`Order.buildApprovedAt`) */
	approvedThisWeek: z.number().int().nonnegative(),
	/** `DEMO_WEEKLY_CAP`: approvals allowed per rolling week without `force` */
	cap: z.number().int().nonnegative(),
})
export type DemoQueueResponse = z.infer<typeof DemoQueueResponseSchema>

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
	/**
	 * A confirmed teardown's preview-resource cleanup per provisioning job (database + role,
	 * storage prefix + role) — wave 14. Absent for other actions and dry-runs.
	 */
	previewResources: z.array(PreviewTeardownReportSchema).optional(),
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

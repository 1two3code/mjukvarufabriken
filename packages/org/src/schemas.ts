import { z } from 'zod'

/**
 * A customer slug: lowercase DNS-ish label used in the account name and root email. Kept strict so
 * `mf-customer-<slug>` and `aws+<slug>@…` are always valid AWS account names / addresses.
 */
export const SlugSchema = z
	.string()
	.min(2)
	.max(40)
	.regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, 'slug must be lowercase alphanumeric with internal hyphens')

export type Slug = z.infer<typeof SlugSchema>

/** A 12-digit AWS account id. */
export const AccountIdSchema = z.string().regex(/^\d{12}$/, 'account id must be 12 digits')

export type AccountId = z.infer<typeof AccountIdSchema>

/** The three deprovisioning modes: reversible suspend, its inverse resume, and permanent teardown. */
export const DeprovisionModeSchema = z.enum(['suspend', 'resume', 'teardown'])

export type DeprovisionMode = z.infer<typeof DeprovisionModeSchema>

/** Per-resource outcome of a deprovision action (`planned` is the dry-run stand-in). */
export const OutcomeSchema = z.enum([
	'planned',
	'suspended',
	'resumed',
	'deleted',
	'skipped',
	'already-gone',
	'failed',
])

export type Outcome = z.infer<typeof OutcomeSchema>

/** A resource discovered by the `Service=mf-delivery` tag. */
export const DeliveryResourceSchema = z.object({
	arn: z.string().min(1),
	/** The AWS service segment of the ARN (`ecs`, `ecr`, `s3`, …). */
	service: z.string().min(1),
	tags: z.record(z.string(), z.string()),
})

export type DeliveryResource = z.infer<typeof DeliveryResourceSchema>

/** One line of the deprovision audit trail — every resource touched, with what happened to it. */
export const AuditEntrySchema = z.object({
	time: z.iso.datetime(),
	mode: DeprovisionModeSchema,
	arn: z.string().min(1),
	service: z.string().min(1),
	action: z.string().min(1),
	outcome: OutcomeSchema,
	dryRun: z.boolean(),
	detail: z.record(z.string(), z.unknown()).optional(),
	reason: z.string().optional(),
})

export type AuditEntry = z.infer<typeof AuditEntrySchema>

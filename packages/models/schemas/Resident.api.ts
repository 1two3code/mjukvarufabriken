import { z } from 'zod'

/**
 * Resident agent (M8): the contract between a resident installation running in the customer's
 * AWS account (`@mf/resident`) and the factory api. The resident meters its own usage and
 * reports one record per day to `POST /internal/resident/usage` (bearer = the installation's
 * token); the api persists them (`resident_usage`), aggregates them per installation and month
 * and reports the month's billable amount to the payment provider (Stripe billing meter).
 */

// MARK: Ids
/** `YYYY-MM-DD` (UTC) — audit objects and usage records are keyed by day */
export const ResidentDaySchema = z.iso.date()
/** `YYYY-MM` (UTC) — the monthly token cap is counted per month */
export const ResidentMonthSchema = z.string().regex(/^\d{4}-\d{2}$/, 'YYYY-MM')

// MARK: Usage
/** Tokens of one model, all buckets raw plus the budget-weighted total the cap counts */
export const ResidentModelUsageSchema = z.object({
	inputTokens: z.number().int().nonnegative(),
	outputTokens: z.number().int().nonnegative(),
	cacheReadInputTokens: z.number().int().nonnegative(),
	cacheCreationInputTokens: z.number().int().nonnegative(),
	/** What counts against `RESIDENT_MONTHLY_TOKENS` (cache reads weighted at 10 %) */
	budgetTokens: z.number().int().nonnegative(),
})
export type ResidentModelUsage = z.infer<typeof ResidentModelUsageSchema>

/** Billing: Anthropic list price × this factor + the monthly fee (PLAN.md M8 decision) */
export const residentUsageMarkup = 1.5

export const ResidentUsageCostSchema = z.object({
	/** Anthropic list price of the day's tokens, USD */
	listPriceUsd: z.number().nonnegative(),
	/** Multiplier applied to the list price (`residentUsageMarkup`) */
	markup: z.number().positive(),
	/** `listPriceUsd × markup`, USD — what the customer is billed for the day's usage */
	billableUsd: z.number().nonnegative(),
})
export type ResidentUsageCost = z.infer<typeof ResidentUsageCostSchema>

export const ResidentTaskCountsSchema = z.object({
	started: z.number().int().nonnegative(),
	succeeded: z.number().int().nonnegative(),
	failed: z.number().int().nonnegative(),
	pullRequestsOpened: z.number().int().nonnegative(),
})
export type ResidentTaskCounts = z.infer<typeof ResidentTaskCountsSchema>

/** One day of a resident installation, written to its S3 bucket and POSTed to the factory api */
export const ResidentUsageRecordBaseSchema = z.object({
	installationId: z.string().min(1),
	/** `owner/name` of the repository the installation is scoped to */
	repository: z.string().min(1),
	day: ResidentDaySchema,
	month: ResidentMonthSchema,
	tokensByModel: z.record(z.string(), ResidentModelUsageSchema),
	/** Sum of `budgetTokens` over every model */
	totalTokens: z.number().int().nonnegative(),
	tasks: ResidentTaskCountsSchema,
	cost: ResidentUsageCostSchema,
	/** The installation's cap and how much of it the month has used (including this day) */
	monthlyCap: z.object({
		tokens: z.number().int().nonnegative(),
		usedTokens: z.number().int().nonnegative(),
	}),
	/** When the record was produced; a later record for the same day replaces an earlier one */
	generatedAt: z.iso.datetime(),
})

/** `billableUsd` is trusted as far as the day's own figures let the api check it (cents) */
export const residentUsageCostToleranceUsd = 0.01

/**
 * Invariants the resident cannot bend: the month is the day's, the markup is the factory's and
 * the billable amount is the list price × that markup (to the cent). The record carries the
 * customer installation's own numbers, so this is the floor the api can hold it to.
 */
export const residentUsageRecordIssues = (
	record: Pick<ResidentUsageRecord, 'day' | 'month' | 'cost'>
): string[] => {
	const issues: string[] = []
	if (record.month !== record.day.slice(0, 7)) issues.push(`month ${record.month} is not the day's`)
	if (record.cost.markup !== residentUsageMarkup) {
		issues.push(`markup ${record.cost.markup} is not ${residentUsageMarkup}`)
	}
	const expected = record.cost.listPriceUsd * residentUsageMarkup
	if (Math.abs(record.cost.billableUsd - expected) > residentUsageCostToleranceUsd) {
		issues.push(`billableUsd ${record.cost.billableUsd} is not listPriceUsd × ${residentUsageMarkup}`)
	}
	return issues
}

export const ResidentUsageRecordSchema = ResidentUsageRecordBaseSchema.superRefine(
	(record, context) => {
		for (const message of residentUsageRecordIssues(record)) {
			context.addIssue({ code: 'custom', message, path: ['cost'] })
		}
	}
)
export type ResidentUsageRecord = z.infer<typeof ResidentUsageRecordSchema>

// MARK: POST /internal/resident/usage
export const ResidentUsageResponseSchema = z.object({
	/** `installationId/day` — the same day reported twice is stored once (last write wins) */
	id: z.string(),
	stored: z.literal(true),
})
export type ResidentUsageResponse = z.infer<typeof ResidentUsageResponseSchema>

// MARK: Installations (factory side)
/**
 * What the factory knows about a resident installation beyond its bearer token: the customer
 * org it belongs to and the payment provider's customer id its usage is billed to. Created on
 * the first usage record (unlinked) and completed by an admin (`PUT /bff/admin/resident/
 * installations/:id`).
 */
export const ResidentInstallationSchema = z.object({
	id: z.string().min(1),
	orgId: z.string().optional(),
	/** Stripe customer id (`cus_…`) the metered subscription belongs to; unset → not billable */
	billingCustomerId: z.string().optional(),
	createdAt: z.iso.datetime(),
	updatedAt: z.iso.datetime(),
})
export type ResidentInstallation = z.infer<typeof ResidentInstallationSchema>

export const ResidentInstallationMutationSchemas = {
	UpsertInstallation: z
		.object({
			orgId: z.string().min(1).nullable().optional(),
			billingCustomerId: z.string().min(1).nullable().optional(),
		})
		.strict(),
}
export type ResidentInstallationMutation = {
	UpsertInstallation: z.infer<typeof ResidentInstallationMutationSchemas.UpsertInstallation>
}

// MARK: Monthly usage (billing)
/** Usage billed as whole US cents (`billableUsd × 100`, rounded) — the meter's unit */
export const usdCentsOf = (usd: number) => Math.round(usd * 100)

/** What has been reported to the payment provider for one installation and month */
export const ResidentUsageReportSchema = z.object({
	installationId: z.string().min(1),
	month: ResidentMonthSchema,
	/** Cumulative cents reported so far (a later run reports only the difference) */
	usdCents: z.number().int().nonnegative(),
	provider: z.enum(['stripe', 'fake']),
	/** Provider reference of the last report (meter event identifier) */
	reference: z.string().optional(),
	/**
	 * A report reserved but not yet confirmed: the cumulative cents and identifier handed to
	 * the provider. Set before the meter event is sent and cleared once the row is confirmed,
	 * so a run interrupted in between retries the very same event (deduped at the provider)
	 * instead of re-billing the difference
	 */
	pendingUsdCents: z.number().int().nonnegative().optional(),
	pendingIdentifier: z.string().optional(),
	/** When the pending report went in flight; cleared when its run gave up (provider error) */
	pendingAt: z.iso.datetime().optional(),
	reportedAt: z.iso.datetime(),
})
export type ResidentUsageReport = z.infer<typeof ResidentUsageReportSchema>

/** One installation's month, aggregated over its daily records */
export const ResidentUsageSummarySchema = z.object({
	installationId: z.string().min(1),
	orgId: z.string().optional(),
	repository: z.string(),
	month: ResidentMonthSchema,
	/** Days with a record */
	days: z.number().int().nonnegative(),
	totalTokens: z.number().int().nonnegative(),
	listPriceUsd: z.number().nonnegative(),
	billableUsd: z.number().nonnegative(),
	tasks: ResidentTaskCountsSchema,
	/** Latest record's cap view (the cap is per month, so the last day carries the total) */
	monthlyCap: z.object({
		tokens: z.number().int().nonnegative(),
		usedTokens: z.number().int().nonnegative(),
	}),
	/** Set once something has been reported to the provider for this month */
	report: ResidentUsageReportSchema.optional(),
})
export type ResidentUsageSummary = z.infer<typeof ResidentUsageSummarySchema>

export const ResidentUsageQuerySchema = z.object({
	month: ResidentMonthSchema.optional(),
	installationId: z.string().min(1).optional(),
})
export type ResidentUsageQuery = z.infer<typeof ResidentUsageQuerySchema>

/**
 * Outcome per installation of a billing run for one month: `reported` = the unbilled part
 * was reported now; `unchanged` = nothing new since the last run; `overreported` = the month's
 * total dropped below what was reported (a corrected day) — a credit is due at the provider,
 * `reason` carries the cents; `no_customer` = the installation has no billing customer id
 * yet; `in_progress` = another run holds the month's report right now; `failed` = the
 * provider rejected it (the reservation stays and is retried as-is on the next run)
 */
export const residentBillingOutcome = [
	'reported',
	'unchanged',
	'overreported',
	'no_customer',
	'in_progress',
	'failed',
] as const
export type ResidentBillingOutcome = (typeof residentBillingOutcome)[number]

export const ResidentBillingResultSchema = z.object({
	installationId: z.string(),
	outcome: z.enum(residentBillingOutcome),
	/** Cents reported in this run (0 unless `reported`) */
	usdCents: z.number().int().nonnegative(),
	/** Cumulative cents reported for the month after this run */
	totalUsdCents: z.number().int().nonnegative(),
	reason: z.string().optional(),
})
export type ResidentBillingResult = z.infer<typeof ResidentBillingResultSchema>

export const ResidentBillingRunResponseSchema = z.object({
	month: ResidentMonthSchema,
	provider: z.enum(['stripe', 'fake']),
	results: z.array(ResidentBillingResultSchema),
})
export type ResidentBillingRunResponse = z.infer<typeof ResidentBillingRunResponseSchema>

// MARK: Audit
export const residentAuditType = [
	'resident_started',
	'paused',
	'resumed',
	'cap_reached',
	'task_queued',
	'task_started',
	'planned',
	'worker',
	'files_changed',
	'command_run',
	'gate',
	'tokens',
	'task_finished',
	'task_failed',
	'task_requeued',
	'pr_opened',
	'usage_reported',
] as const
export type ResidentAuditType = (typeof residentAuditType)[number]

/** One line of the per-day audit log (`audit/<day>.jsonl`), exposed via `GET /audit?day=` */
export const ResidentAuditEntrySchema = z.object({
	time: z.iso.datetime(),
	type: z.enum(residentAuditType),
	taskId: z.string().optional(),
	detail: z.record(z.string(), z.unknown()),
})
export type ResidentAuditEntry = z.infer<typeof ResidentAuditEntrySchema>

export const ResidentAuditResponseSchema = z.object({
	day: ResidentDaySchema,
	entries: z.array(ResidentAuditEntrySchema),
})
export type ResidentAuditResponse = z.infer<typeof ResidentAuditResponseSchema>

// MARK: Tasks
export const residentTaskSource = ['issue', 'api'] as const
export type ResidentTaskSource = (typeof residentTaskSource)[number]

export const residentTaskStatus = ['queued', 'running', 'done', 'failed'] as const
export type ResidentTaskStatus = (typeof residentTaskStatus)[number]

/** A task posted to `POST /tasks` (issues labelled `resident` are converted to the same shape) */
export const NewResidentTaskSchema = z
	.object({
		title: z.string().min(1).max(200),
		/** What to build; markdown checklist lines (`- [ ] …`) become acceptance criteria */
		description: z.string().min(1).max(20_000),
	})
	.strict()
export type NewResidentTask = z.infer<typeof NewResidentTaskSchema>

export const ResidentTaskSchema = NewResidentTaskSchema.extend({
	id: z.string().min(1),
	source: z.enum(residentTaskSource),
	/** GitHub issue number when `source` is `issue` */
	issueNumber: z.number().int().positive().optional(),
	status: z.enum(residentTaskStatus),
	tokensUsed: z.number().int().nonnegative(),
	pullRequestUrl: z.string().optional(),
	reason: z.string().optional(),
	createdAt: z.iso.datetime(),
	finishedAt: z.iso.datetime().optional(),
})
export type ResidentTask = z.infer<typeof ResidentTaskSchema>

export const ResidentTasksResponseSchema = z.object({ tasks: z.array(ResidentTaskSchema) })
export type ResidentTasksResponse = z.infer<typeof ResidentTasksResponseSchema>

// MARK: Status
export const ResidentStatusSchema = z.object({
	installationId: z.string(),
	repository: z.string(),
	paused: z.boolean(),
	month: ResidentMonthSchema,
	monthlyCap: z.object({
		tokens: z.number().int().nonnegative(),
		usedTokens: z.number().int().nonnegative(),
		remainingTokens: z.number().int().nonnegative(),
		reached: z.boolean(),
	}),
	/** Task currently being built, if any */
	running: ResidentTaskSchema.optional(),
	queued: z.number().int().nonnegative(),
})
export type ResidentStatus = z.infer<typeof ResidentStatusSchema>

export const ResidentPauseResponseSchema = z.object({ paused: z.boolean() })
export type ResidentPauseResponse = z.infer<typeof ResidentPauseResponseSchema>

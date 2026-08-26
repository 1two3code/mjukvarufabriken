import { z } from 'zod'

/**
 * Resident agent (M8): the contract between a resident installation running in the customer's
 * AWS account (`@mf/resident`) and the factory api. The resident meters its own usage and
 * reports one record per day to `POST /internal/resident/usage` (bearer = the installation's
 * token); m6-orders turns the records into Stripe usage-based billing.
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
export const ResidentUsageRecordSchema = z.object({
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
export type ResidentUsageRecord = z.infer<typeof ResidentUsageRecordSchema>

// MARK: POST /internal/resident/usage
export const ResidentUsageResponseSchema = z.object({
	/** `installationId/day` — the same day reported twice is stored once (last write wins) */
	id: z.string(),
	stored: z.literal(true),
})
export type ResidentUsageResponse = z.infer<typeof ResidentUsageResponseSchema>

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

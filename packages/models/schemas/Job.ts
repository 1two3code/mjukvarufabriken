import { z } from 'zod'

import { JobUsageSchema } from './ModelPrice.ts'
import { SpecSchema } from './Spec.ts'

// MARK: Enums
export const jobStatus = [
	'queued',
	'planning',
	'building',
	'verifying',
	'delivered',
	'failed',
	'killed',
] as const
export type JobStatus = (typeof jobStatus)[number]

/** Statuses a job can still move out of — everything else is final */
/**
 * `build` plans, builds and delivers from the spec; `redeliver` skips straight to delivery of a
 * repository an earlier job of the same order already delivered — the retry for a build whose
 * gates passed but whose hosting side failed (no rebuild, near-zero tokens).
 */
export const jobMode = ['build', 'redeliver'] as const
export type JobMode = (typeof jobMode)[number]

export const activeJobStatus = ['queued', 'planning', 'building', 'verifying'] as const
export const isActiveJobStatus = (status: JobStatus) =>
	(activeJobStatus as readonly string[]).includes(status)

export const jobEventType = [
	'started',
	'planned',
	'task_started',
	'task_finished',
	'task_failed',
	'merge',
	'verify',
	'gate',
	'delivery',
	'notify',
	'done',
	'failed',
	'killed',
	'log',
	'retry',
] as const
export type JobEventType = (typeof jobEventType)[number]

// MARK: Plan
/** Task id: short, filesystem- and git-branch-safe (`task/<id>`) */
export const TaskIdSchema = z
	.string()
	.regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'lower-case letters, digits and dashes only')

export const TaskSchema = z.object({
	id: TaskIdSchema,
	title: z.string().min(1),
	/** What to build, precise enough for a worker with no other context than the spec */
	description: z.string().min(1),
	/** Ids of tasks that must be merged before this one starts */
	dependsOn: z.array(TaskIdSchema),
	/** Areas of the repo the task touches, e.g. `apps/app`, `apps/api`, `packages/models` */
	areas: z.array(z.string()),
	/** Acceptance-criteria ids (`f<feature index>.c<criterion index>`, zero-based) this task satisfies */
	acceptanceCriteriaIds: z.array(z.string()),
})
export type Task = z.infer<typeof TaskSchema>

export const PlanSchema = z.object({
	summary: z.string(),
	tasks: z.array(TaskSchema).min(1).max(40),
})
export type Plan = z.infer<typeof PlanSchema>

// MARK: Budget
export const JobBudgetSchema = z.object({
	/** Hard cap on total tokens (input + output + cache) for the whole job */
	maxTokens: z.number().int().positive(),
	/** Wall-clock limit for the job */
	maxDurationMinutes: z.number().int().positive(),
	/** Maximum number of parallel workers */
	maxWorkers: z.number().int().positive(),
})
export type JobBudget = z.infer<typeof JobBudgetSchema>

// MARK: Gates
/**
 * QA gates in the order they run after the last merge; the first red gate fails the job.
 * `licence` is deterministic (no model call): dependency licences against a denylist.
 */
export const gateName = [
	'verify',
	'acceptance-tests',
	'review',
	'licence',
	'acceptance-check',
] as const
export type GateName = (typeof gateName)[number]

export const reviewSeverity = ['high', 'medium', 'low'] as const
export type ReviewSeverity = (typeof reviewSeverity)[number]

/** One finding of the independent review gate; `id` is what `Job.gateWaivers` refers to */
export const ReviewFindingSchema = z.object({
	/** `<file>:<line>` — stable across re-reviews so an admin can waive it up front */
	id: z.string().min(1),
	severity: z.enum(reviewSeverity),
	file: z.string().min(1),
	line: z.number().int().nonnegative(),
	claim: z.string().min(1),
	failureScenario: z.string().min(1),
})
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>

/** One installed package as the licence gate saw it (also a row of `THIRD-PARTY-LICENCES.md`) */
export const LicenceEntrySchema = z.object({
	name: z.string().min(1),
	version: z.string().min(1),
	/** SPDX expression from `package.json`, or `UNKNOWN` when the package declares none */
	licence: z.string().min(1),
	repository: z.string().optional(),
})
export type LicenceEntry = z.infer<typeof LicenceEntrySchema>

/** A package the denylist rejected; `waiverId` is what `Job.gateWaivers` must contain to accept it */
export const LicenceViolationSchema = LicenceEntrySchema.extend({
	waiverId: z.string().min(1),
	reason: z.string().min(1),
})
export type LicenceViolation = z.infer<typeof LicenceViolationSchema>

/** `GateReport.details` of the licence gate */
export const LicenceGateDetailsSchema = z.object({
	packages: z.number().int().nonnegative(),
	/** Licence expression → number of packages */
	byLicence: z.record(z.string(), z.number().int().nonnegative()),
	violations: z.array(LicenceViolationSchema),
	waived: z.array(LicenceViolationSchema),
	/** `name@version` pinned in the lockfile but not installed on the build platform (unchecked) */
	missing: z.array(z.string()),
	/** Path of the generated licence list, relative to the repo root */
	file: z.string(),
})
export type LicenceGateDetails = z.infer<typeof LicenceGateDetailsSchema>

export const acceptanceStatus = ['met', 'unmet', 'unknown'] as const
export type AcceptanceStatus = (typeof acceptanceStatus)[number]

export const AcceptanceEvidenceSchema = z.object({
	/** Passing acceptance test file(s) and, for UI criteria, what the test asserts */
	evidence: z.array(z.string()),
	status: z.enum(acceptanceStatus),
})
export type AcceptanceEvidence = z.infer<typeof AcceptanceEvidenceSchema>

/** Criterion id (`f<n>.c<m>`) → evidence; every criterion of the spec must be present and `met` */
export const AcceptanceReportSchema = z.record(z.string(), AcceptanceEvidenceSchema)
export type AcceptanceReport = z.infer<typeof AcceptanceReportSchema>

/** Outcome of one gate, emitted as a `gate` event and stored on the job (`jobs.gates`) */
export const GateReportSchema = z.object({
	name: z.enum(gateName),
	ok: z.boolean(),
	startedAt: z.iso.datetime(),
	durationMs: z.number().int().nonnegative(),
	tokens: z.number().int().nonnegative(),
	summary: z.string(),
	details: z.record(z.string(), z.unknown()).optional(),
})
export type GateReport = z.infer<typeof GateReportSchema>

/** Payload of the `notify` job event — the api forwards it as an email to the admins */
export const notifySubjectMaxLength = 200
export const notifyTextMaxLength = 20_000
export const NotifyPayloadSchema = z.object({
	to: z.literal('admins'),
	subject: z.string().min(1).max(notifySubjectMaxLength),
	text: z.string().max(notifyTextMaxLength),
	/**
	 * What the notification is about, when the sender can say. `job-failed` marks the
	 * orchestrator's build-failure notification — the api holds that mail (only that mail) for a
	 * job it is about to auto-retry, so a human is paged on the second failure, not the first.
	 */
	kind: z.enum(['job-failed']).optional(),
})
export type NotifyPayload = z.infer<typeof NotifyPayloadSchema>

// MARK: Job
export const JobSchema = z.object({
	id: z.string(),
	orderId: z.string(),
	orgId: z.string(),
	status: z.enum(jobStatus),
	spec: SpecSchema,
	budget: JobBudgetSchema,
	tokensUsed: z.number().int().nonnegative(),
	/** Raw four-bucket usage per model — what the Anthropic console meters; absent on older jobs */
	usage: JobUsageSchema.optional(),
	/** USD at the prices in effect when the order was created (`model_prices`); absent on older jobs */
	costUsd: z.number().nonnegative().optional(),
	plan: PlanSchema.optional(),
	/** Human-readable reason when `status` is `failed` or `killed` */
	reason: z.string().optional(),
	/** QA gate reports in run order (M4); absent until the first gate has run */
	gates: z.array(GateReportSchema).optional(),
	/** Review finding ids (`<file>:<line>`) and licence waivers (`licence:<pkg>@<version>`) an admin has waived for this job */
	gateWaivers: z.array(z.string()).optional(),
	/**
	 * Approve-before-deliver hold (W9): once the M4 gates pass green a job whose order has the
	 * `approveBeforeDeliver` flag pauses here instead of delivering. `awaitingApproval` is set while
	 * it waits; `approved` flips when a human accepts and the paused job resumes into delivery.
	 */
	awaitingApproval: z.boolean().optional(),
	approved: z.boolean().optional(),
	/** ECS task ARN once the job runs on Fargate */
	taskArn: z.string().optional(),
	repositoryUrl: z.string().optional(),
	/** Absent = `build` (rows from before the mode existed) */
	mode: z.enum(jobMode).optional(),
	/** The job whose delivered repository a `redeliver` job delivers again */
	sourceJobId: z.string().optional(),
	startedAt: z.iso.datetime().optional(),
	finishedAt: z.iso.datetime().optional(),
	createdAt: z.iso.datetime(),
})
export type Job = z.infer<typeof JobSchema>

// MARK: Events
export const JobEventSchema = z.object({
	id: z.number().int(),
	jobId: z.string(),
	type: z.enum(jobEventType),
	payload: z.record(z.string(), z.unknown()),
	createdAt: z.iso.datetime(),
})
export type JobEvent = z.infer<typeof JobEventSchema>

/** An event before it is stored (no id / timestamp yet) */
export const NewJobEventSchema = JobEventSchema.pick({ type: true, payload: true })
export type NewJobEvent = z.infer<typeof NewJobEventSchema>

import { z } from 'zod'

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
	'notify',
	'done',
	'failed',
	'killed',
	'log',
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
/** QA gates in the order they run after the last merge; the first red gate fails the job */
export const gateName = ['verify', 'acceptance-tests', 'review', 'acceptance-check'] as const
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
export const NotifyPayloadSchema = z.object({
	to: z.literal('admins'),
	subject: z.string().min(1),
	text: z.string(),
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
	plan: PlanSchema.optional(),
	/** Human-readable reason when `status` is `failed` or `killed` */
	reason: z.string().optional(),
	/** QA gate reports in run order (M4); absent until the first gate has run */
	gates: z.array(GateReportSchema).optional(),
	/** Review finding ids (`<file>:<line>`) an admin has waived for this job */
	gateWaivers: z.array(z.string()).optional(),
	/** ECS task ARN once the job runs on Fargate */
	taskArn: z.string().optional(),
	repositoryUrl: z.string().optional(),
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

import { z } from 'zod'

import {
	GateReportSchema,
	JobBudgetSchema,
	jobStatus,
	NewJobEventSchema,
	PlanSchema,
} from './Job.ts'
import { JobUsageSchema } from './ModelPrice.ts'
import { SpecSchema } from './Spec.ts'

/**
 * The build container's view of its job and the writes it may make, all through the api's
 * per-job endpoint (`/internal/jobs/:jobId`, bearer = the job's report token). The job never
 * sees other rows, ids or the database. (M3 hardening, docs/M3-REVIEW.md #18)
 */

// MARK: GET /internal/jobs/:jobId
export const JobReportSchema = z.object({
	id: z.string(),
	status: z.enum(jobStatus),
	spec: SpecSchema,
	budget: JobBudgetSchema,
	gateWaivers: z.array(z.string()).optional(),
	/** True once the admin kill switch flipped the row — the job aborts on its next poll */
	killed: z.boolean(),
	/**
	 * GitHub login of the order's creator as of their latest GitHub sign-in (M6) — the account
	 * M5 delivery adds as admin on the repo. Absent until the customer has signed in with GitHub
	 */
	customerGithubLogin: z.string().optional(),
	/**
	 * Approve-before-deliver gate (W9), resolved from the order: when true the job holds after the
	 * green gates instead of delivering. `approved` is the resume signal the paused job polls for —
	 * a human flips it once they accept, and delivery proceeds. Both optional and absent-means-false
	 * so the report response shape is unchanged for consumers predating the hold (auto-deliver).
	 */
	approveBeforeDeliver: z.boolean().optional(),
	approved: z.boolean().optional(),
})
export type JobReport = z.infer<typeof JobReportSchema>

// MARK: POST /internal/jobs/:jobId/token
/**
 * One-shot exchange of the bootstrap token from the RunTask override (visible in the task's
 * environment, `ecs:DescribeTasks` and CloudTrail) for a fresh one only the job process holds.
 * The old token stops working the moment the exchange succeeds.
 */
export const JobReportTokenResponseSchema = z.object({ token: z.string().min(1) })
export type JobReportTokenResponse = z.infer<typeof JobReportTokenResponseSchema>

// MARK: POST /internal/jobs/:jobId/events
/**
 * `seq` numbers the container's events 1, 2, 3… per job so a batch replayed after a lost
 * response is stored once (unique `(job_id, seq)`); a duplicate is acknowledged but has no side
 * effects (no admin mail, no second gate report).
 */
export const JobReportEventSchema = NewJobEventSchema.extend({
	seq: z.number().int().positive().optional(),
})
export type JobReportEvent = z.infer<typeof JobReportEventSchema>

export const JobReportEventsBodySchema = z
	.object({ events: z.array(JobReportEventSchema).min(1).max(100) })
	.strict()
export type JobReportEventsBody = z.infer<typeof JobReportEventsBodySchema>

/** `notify` events per job the api will still mail — the orchestrator sends at most one */
export const jobNotifyEventsMax = 10

export const JobReportEventsResponseSchema = z.object({
	/** Id of the last stored event */
	lastEventId: z.number().int(),
})
export type JobReportEventsResponse = z.infer<typeof JobReportEventsResponseSchema>

// MARK: PATCH /internal/jobs/:jobId
/** A running job can move forward or end — it never re-queues itself */
export const jobReportStatus = jobStatus.filter(status => status !== 'queued')

/**
 * The harness builds a failure reason from raw worker output (lint/test logs of every failed
 * task); the reporter truncates to this before the PATCH so the final write is never rejected
 */
export const jobReasonMaxLength = 20_000

export const JobReportUpdateSchema = z
	.object({
		status: z.enum(jobReportStatus).optional(),
		tokensUsed: z.number().int().nonnegative().optional(),
		/** Raw four-bucket usage per model so far; the api prices it at the order's model prices */
		usage: JobUsageSchema.optional(),
		plan: PlanSchema.optional(),
		reason: z.string().max(jobReasonMaxLength).optional(),
		gates: z.array(GateReportSchema).optional(),
		/** Set true when the job reaches the approve-before-deliver hold (W9); the api exposes it */
		awaitingApproval: z.boolean().optional(),
		repositoryUrl: z.string().max(2000).optional(),
		startedAt: z.iso.datetime().optional(),
		finishedAt: z.iso.datetime().optional(),
	})
	.strict()
export type JobReportUpdate = z.infer<typeof JobReportUpdateSchema>

export const JobReportUpdateResponseSchema = z.object({
	status: z.enum(jobStatus),
	/** True when the write was refused (or downgraded) because the row is `killed` */
	killed: z.boolean(),
})
export type JobReportUpdateResponse = z.infer<typeof JobReportUpdateResponseSchema>

// MARK: POST /internal/jobs/:jobId/database
/**
 * Per-delivery database provisioning (Gate C, docs/DELIVERED-DB.md): the api — which holds the
 * platform database credentials — creates a dedicated database + login role for this job's
 * delivered app and returns the connection string. The build container only ever sees this
 * scoped URL, never the admin credentials.
 */
export const JobDatabaseResponseSchema = z.object({
	/** `postgres://<role>:<password>@<host>:<port>/<database>` — the delivered app's own scoped DB */
	databaseUrl: z.string().min(1),
})
export type JobDatabaseResponse = z.infer<typeof JobDatabaseResponseSchema>

// MARK: POST /internal/jobs/:jobId/preview-token
/**
 * Short-lived access token for the delivered preview app (audience = the preview audience the
 * delivered api verifies, NEVER this api's own audience) so the post-deploy acceptance check can
 * exercise auth-gated routes instead of stopping at 401.
 */
export const JobPreviewTokenResponseSchema = z.object({ token: z.string().min(1) })
export type JobPreviewTokenResponse = z.infer<typeof JobPreviewTokenResponseSchema>

import { z } from 'zod'

import {
	GateReportSchema,
	JobBudgetSchema,
	jobStatus,
	NewJobEventSchema,
	PlanSchema,
} from './Job.ts'
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
})
export type JobReport = z.infer<typeof JobReportSchema>

// MARK: POST /internal/jobs/:jobId/events
export const JobReportEventsBodySchema = z
	.object({ events: z.array(NewJobEventSchema).min(1).max(100) })
	.strict()
export type JobReportEventsBody = z.infer<typeof JobReportEventsBodySchema>

export const JobReportEventsResponseSchema = z.object({
	/** Id of the last stored event */
	lastEventId: z.number().int(),
})
export type JobReportEventsResponse = z.infer<typeof JobReportEventsResponseSchema>

// MARK: PATCH /internal/jobs/:jobId
/** A running job can move forward or end — it never re-queues itself */
export const jobReportStatus = jobStatus.filter(status => status !== 'queued')

export const JobReportUpdateSchema = z
	.object({
		status: z.enum(jobReportStatus).optional(),
		tokensUsed: z.number().int().nonnegative().optional(),
		plan: PlanSchema.optional(),
		reason: z.string().max(4000).optional(),
		gates: z.array(GateReportSchema).optional(),
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

import { z } from 'zod'

import { JobEventSchema, JobSchema } from './Job.ts'

// MARK: Queries
export const JobQuerySchemas = {
	/** `after` is the id of the last event the client has seen (0 = from the start) */
	GetJobEvents: z.object({ after: z.coerce.number().int().nonnegative().default(0) }).strict(),
}

export type JobQuery = {
	GetJobEvents: z.infer<typeof JobQuerySchemas.GetJobEvents>
}

// MARK: Custom responses
export const JobResponseSchema = JobSchema
export const JobListResponseSchema = z.array(JobSchema)
export const JobEventListResponseSchema = z.array(JobEventSchema)

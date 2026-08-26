import { JobReportEventsBodySchema, JobReportEventsResponseSchema } from '@mf/models'
import { tryCatch } from '@mf/utils/function'

import { EntityInvalid } from '#/lib/entityError.ts'
import {
	authenticateJobReport,
	jobParams,
	reportBodyLimit,
} from '#/routes/internal/jobs/jobToken.utils.ts'

import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	params: jobParams,
	body: JobReportEventsBodySchema,
	response: { 200: JobReportEventsResponseSchema },
}

/**
 * Batch of job events from the build container. Numbered events (`seq`) are stored once, so a
 * retried batch is safe; `notify` events are mailed to the admins; a malformed `gate` payload
 * rejects the whole batch (400) before anything is stored.
 */
const route: FastifyPluginAsyncZod = async function (app) {
	const { jobService } = app

	app.post(
		'/internal/jobs/:jobId/events',
		{ schema, bodyLimit: reportBodyLimit },
		async (request, reply) => {
			const job = await authenticateJobReport(app, request, reply, request.params.jobId)
			if (!job) return
			const [error, result] = await tryCatch(jobService.reportEvents(job, request.body.events))
			if (error) return reply.error(error instanceof EntityInvalid ? 400 : 500, error)
			return reply.send(result)
		}
	)
}

export default route

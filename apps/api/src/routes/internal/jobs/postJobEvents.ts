import { JobReportEventsBodySchema, JobReportEventsResponseSchema } from '@mf/models'
import { tryCatch } from '@mf/utils/function'

import { authenticateJobReport, jobParams } from '#/routes/internal/jobs/jobToken.utils.ts'

import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	params: jobParams,
	body: JobReportEventsBodySchema,
	response: { 200: JobReportEventsResponseSchema },
}

/** Batch of job events from the build container; `notify` events are mailed to the admins */
const route: FastifyPluginAsyncZod = async function (app) {
	const { jobService } = app

	app.post('/internal/jobs/:jobId/events', { schema }, async (request, reply) => {
		const job = await authenticateJobReport(app, request, reply, request.params.jobId)
		if (!job) return
		const [error, result] = await tryCatch(jobService.reportEvents(job, request.body.events))
		if (error) return reply.error(500, error)
		return reply.send(result)
	})
}

export default route

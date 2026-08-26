import { JobReportUpdateResponseSchema, JobReportUpdateSchema } from '@mf/models'
import { tryCatch } from '@mf/utils/function'

import { authenticateJobReport, jobParams } from '#/routes/internal/jobs/jobToken.utils.ts'

import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	params: jobParams,
	body: JobReportUpdateSchema,
	response: { 200: JobReportUpdateResponseSchema },
}

/** Status / tokens / plan / gates / urls from the build container; a killed row wins */
const route: FastifyPluginAsyncZod = async function (app) {
	const { jobService } = app

	app.patch('/internal/jobs/:jobId', { schema }, async (request, reply) => {
		const job = await authenticateJobReport(app, request, reply, request.params.jobId)
		if (!job) return
		const [error, result] = await tryCatch(jobService.reportUpdate(job, request.body))
		if (error) return reply.error(500, error)
		return reply.send(result)
	})
}

export default route

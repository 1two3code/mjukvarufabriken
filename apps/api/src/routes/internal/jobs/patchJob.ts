import { JobReportUpdateResponseSchema, JobReportUpdateSchema } from '@mf/models'
import { tryCatch } from '@mf/utils/function'

import {
	authenticateJobReport,
	jobParams,
	reportBodyLimit,
} from '#/routes/internal/jobs/jobToken.utils.ts'
import { StatusRegression } from '#/services/jobService.ts'

import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	params: jobParams,
	body: JobReportUpdateSchema,
	response: { 200: JobReportUpdateResponseSchema },
}

/**
 * Status / tokens / plan / gates / urls from the build container. Status only moves forward
 * (409 otherwise), a terminal status revokes the token, and a killed row wins.
 */
const route: FastifyPluginAsyncZod = async function (app) {
	const { jobService } = app

	app.patch(
		'/internal/jobs/:jobId',
		{ schema, bodyLimit: reportBodyLimit },
		async (request, reply) => {
			const job = await authenticateJobReport(app, request, reply, request.params.jobId)
			if (!job) return
			const [error, result] = await tryCatch(jobService.reportUpdate(job, request.body))
			if (error) return reply.error(error instanceof StatusRegression ? 409 : 500, error)
			return reply.send(result)
		}
	)
}

export default route

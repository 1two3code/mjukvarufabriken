import { JobReportSchema } from '@mf/models'

import { authenticateJobReport, jobParams } from '#/routes/internal/jobs/jobToken.utils.ts'

import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	params: jobParams,
	response: { 200: JobReportSchema },
}

/** The build container's view of its job: spec, budget, waivers and the kill flag (polled) */
const route: FastifyPluginAsyncZod = async function (app) {
	const { jobService } = app

	app.get('/internal/jobs/:jobId', { schema }, async (request, reply) => {
		const job = await authenticateJobReport(app, request, reply, request.params.jobId)
		if (!job) return
		return reply.send(jobService.reportView(job))
	})
}

export default route

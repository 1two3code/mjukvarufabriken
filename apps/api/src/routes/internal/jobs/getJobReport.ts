import { JobReportSchema } from '@mf/models'

import { authenticateJobReport, jobParams } from '#/routes/internal/jobs/jobToken.utils.ts'

import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	params: jobParams,
	response: { 200: JobReportSchema },
}

/** The build container's view of its job: spec, budget, waivers, the kill flag (polled) and the customer's GitHub login (M5 transfer) */
const route: FastifyPluginAsyncZod = async function (app) {
	const { jobService } = app

	app.get('/internal/jobs/:jobId', { schema }, async (request, reply) => {
		const job = await authenticateJobReport(app, request, reply, request.params.jobId)
		if (!job) return
		return reply.send(await jobService.reportView(job))
	})
}

export default route

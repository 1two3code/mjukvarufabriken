import { JobReportTokenResponseSchema } from '@mf/models'

import { authenticateJobReport, jobParams } from '#/routes/internal/jobs/jobToken.utils.ts'

import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	params: jobParams,
	response: { 200: JobReportTokenResponseSchema },
}

/**
 * One-shot token exchange, the first thing the build container does: the bootstrap token from
 * the RunTask override is replaced by a fresh one that only the job process holds. Anything
 * that reads the task environment afterwards (`/proc/*\/environ` from a worker session,
 * `ecs:DescribeTasks`, CloudTrail) finds a dead token.
 */
const route: FastifyPluginAsyncZod = async function (app) {
	const { jobService } = app

	app.post('/internal/jobs/:jobId/token', { schema }, async (request, reply) => {
		const job = await authenticateJobReport(app, request, reply, request.params.jobId)
		if (!job) return
		try {
			return reply.send({ token: await jobService.rotateReportToken(job) })
		} catch (error) {
			return reply.error(500, error as Error)
		}
	})
}

export default route

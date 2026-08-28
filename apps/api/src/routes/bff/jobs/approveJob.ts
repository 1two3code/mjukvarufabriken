import { z } from 'zod'
import { JobResponseSchema } from '@mf/models'
import { tryCatch } from '@mf/utils/function'

import { EntityNotFound } from '#/lib/entityError.ts'
import { JobNotAwaitingApproval } from '#/services/jobService.ts'

import type { FastifyContextConfig } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	params: z.object({ jobId: z.string() }),
	response: { 200: JobResponseSchema },
}

const config = { permissions: ['job:write'] } satisfies FastifyContextConfig

/**
 * Approve-before-deliver hold (W9): a customer or admin of the job's org releases a build parked
 * at the pre-delivery hold — the paused container polls its report view, sees `approved` and
 * resumes into delivery. 409 when the job is not currently awaiting approval.
 */
const route: FastifyPluginAsyncZod = async function (app) {
	const { jobService } = app

	app.post('/bff/jobs/:jobId/approve', { schema, config }, async (request, reply) => {
		const { session, params } = request

		const [error, job] = await tryCatch(jobService.approve(params.jobId, session))
		if (error instanceof EntityNotFound) return reply.error(404, error)
		if (error instanceof JobNotAwaitingApproval) {
			return reply.error(409, error, 'jobNotAwaitingApproval')
		}
		if (error) return reply.error(500, error)
		return reply.send(job)
	})
}

export default route

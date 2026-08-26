import { z } from 'zod'
import { DeliverablesResponseSchema } from '@mf/models'
import { tryCatch } from '@mf/utils/function'

import { EntityNotFound } from '#/lib/entityError.ts'

import type { FastifyContextConfig } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	params: z.object({ jobId: z.string() }),
	response: { 200: DeliverablesResponseSchema },
}

const config = { permissions: ['job:read'] } satisfies FastifyContextConfig

/**
 * The delivered bundle of a job with 15-minute presigned download links (org-scoped). 404 until
 * the job's `bundle` delivery step has succeeded; 503 when the api has no artifacts bucket.
 */
const route: FastifyPluginAsyncZod = async function (app) {
	const { jobService, s3 } = app

	app.get('/bff/jobs/:jobId/deliverables', { schema, config }, async (request, reply) => {
		const { session, params } = request

		if (!s3.configured) return reply.error(503, new Error('deliverable downloads unavailable'))
		const [error, deliverables] = await tryCatch(jobService.getDeliverables(params.jobId, session))
		if (error) return reply.error(error instanceof EntityNotFound ? 404 : 500, error)
		return reply.send(deliverables)
	})
}

export default route

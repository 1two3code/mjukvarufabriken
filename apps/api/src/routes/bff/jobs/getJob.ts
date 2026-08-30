import { z } from 'zod'
import { JobResponseSchema } from '@mf/models'
import { tryCatch } from '@mf/utils/function'

import { EntityNotFound } from '#/lib/entityError.ts'

import type { FastifyContextConfig } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	params: z.object({ jobId: z.string() }),
	response: { 200: JobResponseSchema },
}

const config = { permissions: ['job:read'] } satisfies FastifyContextConfig

const route: FastifyPluginAsyncZod = async function (app) {
	const { jobService } = app

	app.get('/bff/jobs/:jobId', { schema, config }, async (request, reply) => {
		const { session, params } = request

		const [error, job] = await tryCatch(jobService.get(params.jobId, session))
		if (error) return reply.error(error instanceof EntityNotFound ? 404 : 500, error)
		return reply.send(job)
	})
}

export default route

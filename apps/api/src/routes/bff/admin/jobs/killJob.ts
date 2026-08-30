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

const config = { permissions: ['job:admin'] } satisfies FastifyContextConfig

/** Kill switch: marks the job killed and stops its Fargate task */
const route: FastifyPluginAsyncZod = async function (app) {
	const { jobService } = app

	app.post('/bff/admin/jobs/:jobId/kill', { schema, config }, async (request, reply) => {
		const { params } = request

		const [error, job] = await tryCatch(jobService.kill(params.jobId))
		if (error) return reply.error(error instanceof EntityNotFound ? 404 : 500, error)
		return reply.send(job)
	})
}

export default route

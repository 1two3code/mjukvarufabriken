import { z } from 'zod'
import { JobResponseSchema } from '@mf/models'
import { tryCatch } from '@mf/utils/function'

import { JobAlreadyActive, SpecNotFrozen } from '#/services/jobService.ts'

import type { FastifyContextConfig } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	params: z.object({ orderId: z.string() }),
	response: { 201: JobResponseSchema },
}

const config = { permissions: ['job:write'] } satisfies FastifyContextConfig

const route: FastifyPluginAsyncZod = async function (app) {
	const { jobService } = app

	app.post('/bff/orders/:orderId/jobs', { schema, config }, async (request, reply) => {
		const { session, params } = request

		const [error, job] = await tryCatch(jobService.start(params.orderId, session))
		if (error instanceof SpecNotFrozen) return reply.error(409, error, 'specNotFrozen')
		if (error instanceof JobAlreadyActive) return reply.error(409, error, 'jobAlreadyActive')
		if (error) return reply.error(500, error)
		return reply.code(201).send(job)
	})
}

export default route

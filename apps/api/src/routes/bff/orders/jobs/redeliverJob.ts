import { z } from 'zod'
import { JobResponseSchema } from '@mf/models'
import { tryCatch } from '@mf/utils/function'

import { EntityNotFound } from '#/lib/entityError.ts'
import { JobAlreadyActive, NothingToRedeliver } from '#/services/jobService.ts'

import type { FastifyContextConfig } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	params: z.object({ orderId: z.string() }),
	response: { 201: JobResponseSchema },
}

const config = { permissions: ['job:write'] } satisfies FastifyContextConfig

/**
 * Delivers the order's already-delivered repository again — no rebuild. The retry for a build
 * whose gates passed but whose preview never came up (docs/LEARNINGS.md, run 7): near-zero
 * tokens instead of a full build, and the same Express service / database / storage role.
 */
const route: FastifyPluginAsyncZod = async function (app) {
	const { jobService, orderService } = app

	app.post('/bff/orders/:orderId/jobs/redeliver', { schema, config }, async (request, reply) => {
		const { session, params } = request

		const [orderError] = await tryCatch(orderService.get(params.orderId, session))
		if (orderError) return reply.error(orderError instanceof EntityNotFound ? 404 : 500, orderError)

		const [error, job] = await tryCatch(jobService.redeliver(params.orderId, session))
		if (error instanceof NothingToRedeliver) return reply.error(409, error, 'nothingToRedeliver')
		if (error instanceof JobAlreadyActive) return reply.error(409, error, 'jobAlreadyActive')
		if (error) return reply.error(500, error)
		return reply.code(201).send(job)
	})
}

export default route

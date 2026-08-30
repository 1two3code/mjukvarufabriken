import { z } from 'zod'
import { JobListResponseSchema } from '@mf/models'

import type { FastifyContextConfig } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	params: z.object({ orderId: z.string() }),
	response: { 200: JobListResponseSchema },
}

const config = { permissions: ['job:read'] } satisfies FastifyContextConfig

/** Jobs for an order, newest first — the portal shows the latest one */
const route: FastifyPluginAsyncZod = async function (app) {
	const { jobService } = app

	app.get('/bff/orders/:orderId/jobs', { schema, config }, async (request, reply) => {
		const { session, params } = request

		try {
			const jobs = await jobService.listForOrder(params.orderId, session)
			return reply.send(jobs)
		} catch (error) {
			return reply.error(500, error as Error)
		}
	})
}

export default route

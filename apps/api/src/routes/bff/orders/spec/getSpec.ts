import { z } from 'zod'
import { SpecDraftResponseSchema } from '@mf/models'

import type { FastifyContextConfig } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	params: z.object({ orderId: z.string() }),
	response: { 200: SpecDraftResponseSchema },
}

const config = { permissions: ['spec:read'] } satisfies FastifyContextConfig

const route: FastifyPluginAsyncZod = async function (app) {
	const { specService } = app

	app.get('/bff/orders/:orderId/spec', { schema, config }, async (request, reply) => {
		const { orderId } = request.params

		try {
			const draft = await specService.get(orderId)
			return reply.send(draft)
		} catch (error) {
			return reply.error(500, error as Error)
		}
	})
}

export default route

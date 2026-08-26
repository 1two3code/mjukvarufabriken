import { z } from 'zod'
import { OrderDetailResponseSchema } from '@mf/models'
import { tryCatch } from '@mf/utils/function'

import { EntityNotFound } from '#/lib/entityError.ts'

import type { FastifyContextConfig } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	params: z.object({ orderId: z.string() }),
	response: { 200: OrderDetailResponseSchema },
}

const config = { permissions: ['spec:read'] } satisfies FastifyContextConfig

/** Order + spec status + latest job summary + payments — everything the order page shows */
const route: FastifyPluginAsyncZod = async function (app) {
	const { orderService } = app

	app.get('/bff/orders/:orderId', { schema, config }, async (request, reply) => {
		const { session, params } = request

		const [error, detail] = await tryCatch(orderService.getDetail(params.orderId, session))
		if (error) return reply.error(error instanceof EntityNotFound ? 404 : 500, error)
		return reply.send(detail)
	})
}

export default route

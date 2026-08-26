import { OrderMutationSchemas, OrderResponseSchema } from '@mf/models'

import type { FastifyContextConfig } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	body: OrderMutationSchemas.CreateOrder,
	response: { 201: OrderResponseSchema },
}

const config = { permissions: ['spec:write'] } satisfies FastifyContextConfig

/** New order: the api mints the id, the order starts in `drafting` for the session's org */
const route: FastifyPluginAsyncZod = async function (app) {
	const { orderService } = app

	app.post('/bff/orders', { schema, config }, async (request, reply) => {
		const { session, body } = request

		try {
			const order = await orderService.create(body.name, session)
			return reply.code(201).send(order)
		} catch (error) {
			return reply.error(500, error as Error)
		}
	})
}

export default route

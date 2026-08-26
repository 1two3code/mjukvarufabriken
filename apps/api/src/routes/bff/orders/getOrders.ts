import { OrderListResponseSchema } from '@mf/models'

import type { FastifyContextConfig } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	response: { 200: OrderListResponseSchema },
}

const config = { permissions: ['spec:read'] } satisfies FastifyContextConfig

/** The org's orders, newest first (admins see every org) */
const route: FastifyPluginAsyncZod = async function (app) {
	const { orderService } = app

	app.get('/bff/orders', { schema, config }, async (request, reply) => {
		const { session } = request

		try {
			const orders = await orderService.list(session)
			return reply.send(orders)
		} catch (error) {
			return reply.error(500, error as Error)
		}
	})
}

export default route

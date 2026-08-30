import { OrderListResponseSchema } from '@mf/models'

import type { FastifyContextConfig } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	response: { 200: OrderListResponseSchema },
}

const config = { permissions: ['job:admin'] } satisfies FastifyContextConfig

/** Every order across orgs, newest first (admin view: names the jobs' orders) */
const route: FastifyPluginAsyncZod = async function (app) {
	const { db } = app

	app.get('/bff/admin/orders', { schema, config }, async (_request, reply) => {
		try {
			const orders = await db.orders.listOrders()
			return reply.send(orders)
		} catch (error) {
			return reply.error(500, error as Error)
		}
	})
}

export default route

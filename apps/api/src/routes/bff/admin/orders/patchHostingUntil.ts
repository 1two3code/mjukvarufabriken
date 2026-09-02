import { z } from 'zod'
import { OrderMutationSchemas, OrderResponseSchema } from '@mf/models'

import { EntityNotFound } from '#/lib/entityError.ts'

import type { FastifyContextConfig } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	params: z.object({ orderId: z.string() }),
	body: OrderMutationSchemas.SetHostingUntil,
	response: { 200: OrderResponseSchema },
}

const config = { permissions: ['job:admin'] } satisfies FastifyContextConfig

/**
 * Admin override of an order's included hosting window (wave 14): a new instant extends or
 * shortens it, `null` clears the scheduled end so the hosting sweep never picks the order up.
 */
const route: FastifyPluginAsyncZod = async function (app) {
	const { db } = app

	app.patch(
		'/bff/admin/orders/:orderId/hosting-until',
		{ schema, config },
		async (request, reply) => {
			const { params, body } = request

			const hostingUntil = body.hostingUntil === null ? null : new Date(body.hostingUntil)
			const order = await db.orders.setHostingUntil(params.orderId, hostingUntil)
			if (!order) return reply.error(404, new EntityNotFound('order', params.orderId))
			app.log.info({ orderId: order.id, hostingUntil }, 'Hosting window set by admin')
			return reply.send(order)
		}
	)
}

export default route

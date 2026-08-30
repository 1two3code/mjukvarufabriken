import { z } from 'zod'
import { OrderResponseSchema } from '@mf/models'
import { tryCatch } from '@mf/utils/function'

import { EntityNotFound } from '#/lib/entityError.ts'
import { InvalidOrderTransition } from '#/services/orderService.ts'

import type { FastifyContextConfig } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	params: z.object({ orderId: z.string() }),
	response: { 200: OrderResponseSchema },
}

const config = { permissions: ['spec:write'] } satisfies FastifyContextConfig

/**
 * Approve-before-deliver gate (W7): a customer or admin of the order's org approves an
 * `awaiting_approval` order, which then delivers. 409 when the order is not awaiting approval.
 */
const route: FastifyPluginAsyncZod = async function (app) {
	const { orderService } = app

	app.post('/bff/orders/:orderId/approve', { schema, config }, async (request, reply) => {
		const { session, params } = request

		const [error, order] = await tryCatch(orderService.approve(params.orderId, session))
		if (error instanceof EntityNotFound) return reply.error(404, error)
		if (error instanceof InvalidOrderTransition) {
			return reply.error(409, error, 'orderTransitionInvalid')
		}
		if (error) return reply.error(500, error)
		return reply.send(order)
	})
}

export default route

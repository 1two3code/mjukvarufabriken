import { OrderMutationSchemas, OrderResponseSchema } from '@mf/models'
import { z } from 'zod'
import { tryCatch } from '@mf/utils/function'

import { EntityNotFound } from '#/lib/entityError.ts'

import type { FastifyContextConfig } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	params: z.object({ orderId: z.string() }),
	body: OrderMutationSchemas.SetApprovalGate,
	response: { 200: OrderResponseSchema },
}

const config = { permissions: ['job:admin'] } satisfies FastifyContextConfig

/**
 * Admin toggle of the per-order approve-before-deliver gate (W7). Default off, so leaving the
 * gate untouched keeps the existing auto-deliver flow.
 */
const route: FastifyPluginAsyncZod = async function (app) {
	const { orderService } = app

	app.patch('/bff/orders/:orderId/approval-gate', { schema, config }, async (request, reply) => {
		const { session, params, body } = request

		const [error, order] = await tryCatch(
			orderService.setApprovalGate(params.orderId, body.enabled, session)
		)
		if (error instanceof EntityNotFound) return reply.error(404, error)
		if (error) return reply.error(500, error)
		return reply.send(order)
	})
}

export default route

import { DemoQueueResponseSchema } from '@mf/models'

import type { FastifyContextConfig } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	response: { 200: DemoQueueResponseSchema },
}

const config = { permissions: ['job:admin'] } satisfies FastifyContextConfig

/**
 * The admin's demo queue (wave 14): paid voucher demos waiting for a build approval, oldest
 * first, with how much of the weekly cap is used. Static path, so it never collides with the
 * `/bff/admin/orders/:orderId/*` actions.
 */
const route: FastifyPluginAsyncZod = async function (app) {
	const { orderService } = app

	app.get('/bff/admin/orders/demo-queue', { schema, config }, async (_request, reply) => {
		try {
			return reply.send(await orderService.demoQueue())
		} catch (error) {
			return reply.error(500, error as Error)
		}
	})
}

export default route

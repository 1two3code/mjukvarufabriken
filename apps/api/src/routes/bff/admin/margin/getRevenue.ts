import { CustomerRevenueListResponseSchema } from '@mf/models'

import type { FastifyContextConfig } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	response: { 200: CustomerRevenueListResponseSchema },
}

const config = { permissions: ['job:admin'] } satisfies FastifyContextConfig

/**
 * M12 margin calculator (PLAN.md): build fee + hosting + SLA + further dev + resident tokens×1.5,
 * per org — aggregated from the existing `orders`/`payments`/`resident_usage` data, not a new
 * payment flow. `hostingSek`/`slaSek`/`furtherDevSek` are 0 until those payment kinds exist.
 */
const route: FastifyPluginAsyncZod = async function (app) {
	const { marginService } = app

	app.get('/bff/admin/margin/revenue', { schema, config }, async (_request, reply) => {
		try {
			return reply.send(await marginService.revenueByCustomer())
		} catch (error) {
			return reply.error(500, error as Error)
		}
	})
}

export default route

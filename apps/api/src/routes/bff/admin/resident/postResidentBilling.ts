import { z } from 'zod'
import { ResidentBillingRunResponseSchema, ResidentMonthSchema } from '@mf/models'

import type { FastifyContextConfig } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	params: z.object({ month: ResidentMonthSchema }),
	response: { 200: ResidentBillingRunResponseSchema },
}

const config = { permissions: ['job:admin'] } satisfies FastifyContextConfig

/**
 * Runs resident usage billing for one month: every installation's unreported billable cents
 * go to the payment provider's meter. Safe to repeat — an unchanged month reports nothing.
 * Meant to be run after month end (and again for late records).
 */
const route: FastifyPluginAsyncZod = async function (app) {
	const { paymentService } = app

	app.post('/bff/admin/resident/usage/:month/bill', { schema, config }, async (request, reply) => {
		try {
			return reply.send(await paymentService.billResidentUsage(request.params.month))
		} catch (error) {
			return reply.error(500, error as Error)
		}
	})
}

export default route

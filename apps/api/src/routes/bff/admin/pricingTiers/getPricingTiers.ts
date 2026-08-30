import { z } from 'zod'
import { PricingTierRowSchema } from '@mf/models'

import type { FastifyContextConfig } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	response: { 200: z.array(PricingTierRowSchema) },
}

const config = { permissions: ['job:admin'] } satisfies FastifyContextConfig

/** The whole pricing-tier table, newest `effectiveFrom` first (admin view; migration 0019) */
const route: FastifyPluginAsyncZod = async function (app) {
	const { db } = app

	app.get('/bff/admin/pricing-tiers', { schema, config }, async (_request, reply) => {
		try {
			return reply.send(await db.pricingTiers.list())
		} catch (error) {
			return reply.error(500, error as Error)
		}
	})
}

export default route

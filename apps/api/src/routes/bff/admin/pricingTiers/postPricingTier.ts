import { NewPricingTierSchema, PricingTierRowSchema } from '@mf/models'

import type { FastifyContextConfig } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	body: NewPricingTierSchema,
	response: { 201: PricingTierRowSchema },
}

const config = { permissions: ['job:admin'] } satisfies FastifyContextConfig

/**
 * Adds a pricing-tier row: `name`/`price`/`currency`/`description` for orders from
 * `effectiveFrom` (default now) on. Append-only — earlier orders keep the tier they were shown,
 * so there is no edit or delete; to correct a mistake, add another row.
 */
const route: FastifyPluginAsyncZod = async function (app) {
	const { db } = app

	app.post('/bff/admin/pricing-tiers', { schema, config }, async (request, reply) => {
		try {
			const row = await db.pricingTiers.insert(request.body)
			return reply.status(201).send(row)
		} catch (error) {
			if ((error as { code?: string }).code === '23505')
				{return reply.error(409, new Error('A tier for that key and instant already exists'))}
			return reply.error(500, error as Error)
		}
	})
}

export default route

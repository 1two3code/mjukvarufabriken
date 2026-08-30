import { ModelPriceRowSchema, NewModelPriceSchema } from '@mf/models'

import type { FastifyContextConfig } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	body: NewModelPriceSchema,
	response: { 201: ModelPriceRowSchema },
}

const config = { permissions: ['job:admin'] } satisfies FastifyContextConfig

/**
 * Adds a price row: the prefix's rates for orders created from `effectiveFrom` (default now) on.
 * Append-only — earlier orders keep the prices they were created under, so there is no edit or
 * delete; to correct a mistake, add another row.
 */
const route: FastifyPluginAsyncZod = async function (app) {
	const { db } = app

	app.post('/bff/admin/model-prices', { schema, config }, async (request, reply) => {
		try {
			const row = await db.modelPrices.insert(request.body)
			return reply.status(201).send(row)
		} catch (error) {
			if ((error as { code?: string }).code === '23505')
				{return reply.error(409, new Error('A price for that prefix and instant already exists'))}
			return reply.error(500, error as Error)
		}
	})
}

export default route

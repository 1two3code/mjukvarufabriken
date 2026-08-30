import { z } from 'zod'
import { ModelPriceRowSchema } from '@mf/models'

import type { FastifyContextConfig } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	response: { 200: z.array(ModelPriceRowSchema) },
}

const config = { permissions: ['job:admin'] } satisfies FastifyContextConfig

/** The whole model price table, newest `effectiveFrom` first (admin view; migration 0018) */
const route: FastifyPluginAsyncZod = async function (app) {
	const { db } = app

	app.get('/bff/admin/model-prices', { schema, config }, async (_request, reply) => {
		try {
			return reply.send(await db.modelPrices.list())
		} catch (error) {
			return reply.error(500, error as Error)
		}
	})
}

export default route

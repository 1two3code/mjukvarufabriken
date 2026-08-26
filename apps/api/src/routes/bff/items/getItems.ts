import { ItemQuerySchemas, ItemSchema } from '@mf/models'

import type { FastifyContextConfig } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	querystring: ItemQuerySchemas.GetItems,
	response: { 200: ItemSchema.array() },
}

const config = { permissions: ['item:read'] } satisfies FastifyContextConfig

const route: FastifyPluginAsyncZod = async function (app) {
	const { itemService } = app

	app.get('/bff/items', { schema, config }, async (request, reply) => {
		const { query } = request

		try {
			const items = await itemService.find(query)
			const sortedItems = items.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
			return reply.send(sortedItems)
		} catch (error) {
			return reply.error(500, error as Error)
		}
	})
}

export default route

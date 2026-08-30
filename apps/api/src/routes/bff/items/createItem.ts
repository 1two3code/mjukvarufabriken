import { z } from 'zod'
import { ItemMutationSchemas } from '@template/models'

import type { FastifyContextConfig } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	body: ItemMutationSchemas.CreateItem,
	response: { 200: z.object({ id: z.string() }) },
}

const config = { permissions: ['item:write'] } satisfies FastifyContextConfig

const route: FastifyPluginAsyncZod = async function (app) {
	const { itemService } = app

	app.post('/bff/items', { schema, config }, async (request, reply) => {
		const { body } = request

		try {
			const id = await itemService.create(body)
			return reply.send({ id })
		} catch (error) {
			return reply.error(500, error as Error, 'failedToCreateItem')
		}
	})
}

export default route

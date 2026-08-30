import { z } from 'zod'
import { ItemSchema } from '@mf/models'
import { tryCatch } from '@mf/utils/function'

import { EntityNotFound } from '#/lib/entityError.ts'

import type { FastifyContextConfig } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = { params: z.object({ id: z.string() }), response: { 200: ItemSchema } }

const config = { permissions: ['item:read'] } satisfies FastifyContextConfig

const route: FastifyPluginAsyncZod = async function (app) {
	const { itemService } = app

	app.get('/bff/items/:id', { schema, config }, async (request, reply) => {
		const { id } = request.params
		const [error, item] = await tryCatch(itemService.get(id))
		if (error) return reply.error(error instanceof EntityNotFound ? 404 : 500, error)
		return reply.send(item)
	})
}

export default route

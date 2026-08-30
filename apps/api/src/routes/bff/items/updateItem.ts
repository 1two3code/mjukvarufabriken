import { z } from 'zod'
import { ItemMutationSchemas } from '@mf/models'
import { tryCatch } from '@mf/utils/function'

import { EntityNotFound } from '#/lib/entityError.ts'

import type { FastifyContextConfig } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	params: z.object({ id: z.string() }),
	body: ItemMutationSchemas.UpdateItem,
	response: { 204: z.undefined() },
}

const config = { permissions: ['item:write'] } satisfies FastifyContextConfig

const route: FastifyPluginAsyncZod = async function (app) {
	const { itemService } = app

	app.patch('/bff/items/:id', { schema, config }, async (request, reply) => {
		const { params, body } = request
		const [error] = await tryCatch(itemService.update(params.id, body))
		if (error instanceof EntityNotFound) return reply.error(404, error)
		if (error) return reply.error(500, error, 'failedToUpdateItem')

		return reply.code(204).send()
	})
}

export default route

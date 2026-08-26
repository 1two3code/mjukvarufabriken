import { z } from 'zod'
import { SpecDraftResponseSchema } from '@mf/models'
import { tryCatch } from '@mf/utils/function'

import { EntityInvalid, EntityNotFound } from '#/lib/entityError.ts'

import type { FastifyContextConfig } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	params: z.object({ orderId: z.string() }),
	response: { 200: SpecDraftResponseSchema },
}

const config = { permissions: ['spec:write'] } satisfies FastifyContextConfig

const route: FastifyPluginAsyncZod = async function (app) {
	const { specService } = app

	app.post('/bff/orders/:orderId/spec/freeze', { schema, config }, async (request, reply) => {
		const { session, params } = request

		const [error, draft] = await tryCatch(specService.freeze(params.orderId, session))
		if (error instanceof EntityNotFound) return reply.error(404, error)
		if (error instanceof EntityInvalid) return reply.error(409, error, 'specIncomplete')
		if (error) return reply.error(500, error)
		return reply.send(draft)
	})
}

export default route

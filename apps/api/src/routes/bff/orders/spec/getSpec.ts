import { z } from 'zod'
import { SpecDraftResponseSchema } from '@mf/models'
import { tryCatch } from '@mf/utils/function'

import { EntityNotFound } from '#/lib/entityError.ts'

import type { FastifyContextConfig } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	params: z.object({ orderId: z.string() }),
	response: { 200: SpecDraftResponseSchema },
}

const config = { permissions: ['spec:read'] } satisfies FastifyContextConfig

const route: FastifyPluginAsyncZod = async function (app) {
	const { specService } = app

	app.get('/bff/orders/:orderId/spec', { schema, config }, async (request, reply) => {
		const { session, params } = request

		const [error, draft] = await tryCatch(specService.get(params.orderId, session))
		if (error) return reply.error(error instanceof EntityNotFound ? 404 : 500, error)
		return reply.send(draft)
	})
}

export default route

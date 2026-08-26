import { z } from 'zod'
import { SpecDraftResponseSchema } from '@mf/models'
import { tryCatch } from '@mf/utils/function'

import { EntityInvalid } from '#/lib/entityError.ts'

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
		const { orderId } = request.params

		const [error, draft] = await tryCatch(specService.freeze(orderId))
		if (error instanceof EntityInvalid) return reply.error(409, error, 'specIncomplete')
		if (error) return reply.error(500, error)
		return reply.send(draft)
	})
}

export default route

import { z } from 'zod'
import { SpecDraftResponseSchema, SpecMutationSchemas } from '@mf/models'
import { tryCatch } from '@mf/utils/function'

import { EntityInvalid, EntityNotFound } from '#/lib/entityError.ts'
import { AnthropicNotConfigured } from '#/plugins/anthropic.ts'
import { SpecRateLimited, SpecTurnLimitReached } from '#/services/specService.ts'

import type { FastifyContextConfig } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	params: z.object({ orderId: z.string() }),
	body: SpecMutationSchemas.PostSpecMessage,
	response: { 200: SpecDraftResponseSchema },
}

const config = { permissions: ['spec:write'] } satisfies FastifyContextConfig

const route: FastifyPluginAsyncZod = async function (app) {
	const { specService } = app

	app.post('/bff/orders/:orderId/spec', { schema, config }, async (request, reply) => {
		const { session, params, body } = request

		const [error, draft] = await tryCatch(
			specService.sendMessage(params.orderId, body.content, session)
		)
		if (error instanceof EntityNotFound) return reply.error(404, error)
		if (error instanceof EntityInvalid) return reply.error(409, error, 'specFrozen')
		if (error instanceof SpecTurnLimitReached) return reply.error(409, error, 'specTurnLimit')
		if (error instanceof SpecRateLimited) return reply.error(429, error, 'specRateLimited')
		if (error instanceof AnthropicNotConfigured) {
			return reply.error(503, error, 'specEngineUnavailable')
		}
		if (error) return reply.error(500, error, 'specEngineFailed')
		return reply.send(draft)
	})
}

export default route

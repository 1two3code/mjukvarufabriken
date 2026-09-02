import { ClaimQuoteResponseSchema, QuoteMutationSchemas } from '@mf/models'
import { tryCatch } from '@mf/utils/function'

import { EntityNotFound } from '#/lib/entityError.ts'
import { ClaimRateLimited } from '#/services/orderService.ts'

import type { FastifyContextConfig } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	body: QuoteMutationSchemas.ClaimQuote,
	response: { 200: ClaimQuoteResponseSchema },
}

const config = { permissions: ['spec:write'] } satisfies FastifyContextConfig

/**
 * Claims an anonymous quote from the site for the signed-in session (wave 14, F1): the order
 * becomes the session's org's and the quote token dies. A second claim, a wrong token and an
 * unknown order are all 404; 429 `claimRateLimited` guards against token guessing.
 */
const route: FastifyPluginAsyncZod = async function (app) {
	const { orderService } = app

	app.post('/bff/orders/claim', { schema, config }, async (request, reply) => {
		const { session, body } = request

		const [error, order] = await tryCatch(orderService.claim(body.orderId, body.token, session))
		if (error instanceof EntityNotFound) return reply.error(404, error)
		if (error instanceof ClaimRateLimited) return reply.error(429, error, 'claimRateLimited')
		if (error) return reply.error(500, error)
		return reply.send(order)
	})
}

export default route

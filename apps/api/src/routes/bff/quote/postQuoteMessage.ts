import { z } from 'zod'
import { QuoteMutationSchemas, QuoteResponseSchema } from '@mf/models'
import { tryCatch } from '@mf/utils/function'

import { EntityInvalid, EntityNotFound } from '#/lib/entityError.ts'
import { AnthropicNotConfigured } from '#/plugins/anthropic.ts'
import { clientIp } from '#/routes/bff/contact/contact.utils.ts'
import { quoteTokenOf } from '#/routes/bff/quote/quote.utils.ts'
import { SpecRateLimited, SpecTurnLimitReached } from '#/services/specService.ts'

import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	params: z.object({ orderId: z.string() }),
	body: QuoteMutationSchemas.PostQuoteMessage,
	response: { 200: QuoteResponseSchema },
}

/**
 * Public route (listed in `publicUrls`): one spec-engine turn on the anonymous quote. The same
 * error codes as the portal's `POST /bff/orders/:orderId/spec`, so the site reuses its copy; the
 * token check is 404 like `GET /bff/quote/:orderId`.
 */
const route: FastifyPluginAsyncZod = async function (app) {
	const { quoteService } = app

	app.post('/bff/quote/:orderId/message', { schema }, async (request, reply) => {
		const { params, body, headers, ip } = request

		const token = quoteTokenOf(headers)
		if (!token) return reply.error(404, new EntityNotFound('quote', params.orderId))

		const [error, quote] = await tryCatch(
			quoteService.sendMessage(
				params.orderId,
				token,
				body.content,
				clientIp(headers['x-forwarded-for'], ip)
			)
		)
		if (error instanceof EntityNotFound) return reply.error(404, error)
		if (error instanceof EntityInvalid) return reply.error(409, error, 'specFrozen')
		if (error instanceof SpecTurnLimitReached) return reply.error(409, error, 'specTurnLimit')
		if (error instanceof SpecRateLimited) return reply.error(429, error, 'specRateLimited')
		if (error instanceof AnthropicNotConfigured) {
			return reply.error(503, error, 'specEngineUnavailable')
		}
		if (error) return reply.error(500, error, 'specEngineFailed')
		return reply.send(quote)
	})
}

export default route

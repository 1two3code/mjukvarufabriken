import { z } from 'zod'
import { QuoteResponseSchema } from '@mf/models'
import { tryCatch } from '@mf/utils/function'

import { EntityNotFound } from '#/lib/entityError.ts'
import { clientIp } from '#/routes/bff/contact/contact.utils.ts'
import { quoteTokenOf } from '#/routes/bff/quote/quote.utils.ts'
import { QuoteRateLimited } from '#/services/quoteService.ts'

import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	params: z.object({ orderId: z.string() }),
	response: { 200: QuoteResponseSchema },
}

/**
 * Public route (listed in `publicUrls`): the anonymous quote, for a browser resuming its draft.
 * A missing, malformed or wrong `x-quote-token` — and a quote that was claimed — is 404.
 */
const route: FastifyPluginAsyncZod = async function (app) {
	const { quoteService } = app

	app.get('/bff/quote/:orderId', { schema }, async (request, reply) => {
		const { params, headers, ip } = request

		const token = quoteTokenOf(headers)
		if (!token) return reply.error(404, new EntityNotFound('quote', params.orderId))

		const [error, quote] = await tryCatch(
			quoteService.get(params.orderId, token, clientIp(headers['x-forwarded-for'], ip))
		)
		if (error instanceof EntityNotFound) return reply.error(404, error)
		if (error instanceof QuoteRateLimited) return reply.error(429, error, 'quoteRateLimited')
		if (error) return reply.error(500, error)
		return reply.send(quote)
	})
}

export default route

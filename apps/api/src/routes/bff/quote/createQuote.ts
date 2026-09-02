import { CreateQuoteResponseSchema, QuoteMutationSchemas } from '@mf/models'
import { tryCatch } from '@mf/utils/function'

import { clientIp } from '#/routes/bff/contact/postContact.ts'
import { QuoteRateLimited } from '#/services/quoteService.ts'

import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	body: QuoteMutationSchemas.CreateQuote,
	response: { 201: CreateQuoteResponseSchema },
}

/**
 * Public route (listed in `publicUrls`): starts an anonymous quote for the site's no-login spec
 * chat. The response carries the quote token exactly once; the site sends it back as
 * `x-quote-token` on every later call. 429 `quoteRateLimited` when the ip has started too many.
 */
const route: FastifyPluginAsyncZod = async function (app) {
	const { quoteService } = app

	app.post('/bff/quote', { schema }, async (request, reply) => {
		const { body, headers, ip } = request

		const [error, created] = await tryCatch(
			quoteService.create(clientIp(headers['x-forwarded-for'], ip), body?.name)
		)
		if (error instanceof QuoteRateLimited) return reply.error(429, error, 'quoteRateLimited')
		if (error) return reply.error(500, error)
		return reply.code(201).send(created)
	})
}

export default route

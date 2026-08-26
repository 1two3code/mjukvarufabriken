import { z } from 'zod'
import { tryCatch } from '@mf/utils/function'

import { InvalidWebhookSignature } from '#/services/paymentService.ts'

import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	body: z.string(),
	response: {
		200: z.object({
			received: z.literal(true),
			eventId: z.string(),
			outcome: z.enum(['applied', 'duplicate', 'ignored']),
		}),
	},
}

/**
 * Stripe webhook (public, listed in the auth plugin's `publicUrls`). The body is kept raw so
 * the signature can be verified over the exact bytes; the service is idempotent on the event
 * id, so Stripe's retries are safe. A bad signature is 400; a failure after verification is
 * 500 so Stripe retries the delivery.
 */
const route: FastifyPluginAsyncZod = async function (app) {
	const { paymentService } = app

	// Scoped to this plugin: keeps JSON as the raw string instead of parsing it
	app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) =>
		done(null, body)
	)

	app.post('/bff/stripe/webhook', { schema }, async (request, reply) => {
		const { body, headers } = request
		const signature = headers['stripe-signature']

		const [error, result] = await tryCatch(
			paymentService.handleWebhook(body, Array.isArray(signature) ? signature[0] : signature)
		)
		if (error instanceof InvalidWebhookSignature) return reply.error(400, error)
		if (error) return reply.error(500, error)
		return reply.send({ received: true, eventId: result.eventId, outcome: result.outcome })
	})
}

export default route

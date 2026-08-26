import { z } from 'zod'
import { tryCatch } from '@mf/utils/function'

import { EntityNotFound } from '#/lib/entityError.ts'
import { FakeProviderInactive } from '#/services/paymentService.ts'

import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	params: z.object({ sessionId: z.string() }),
	querystring: z.object({ kind: z.string().optional() }),
}

/**
 * FAKE PAYMENT PROVIDER (dev/test only, active when STRIPE_SECRET_KEY is absent). The Checkout
 * "page": marks the session paid exactly like a `checkout.session.completed` webhook would and
 * sends the browser back to the order page. Public (listed in the auth plugin's `publicUrls`);
 * with Stripe configured it is a 404.
 */
const route: FastifyPluginAsyncZod = async function (app) {
	const { paymentService, secrets } = app

	app.get('/bff/stripe/fake/checkout/:sessionId', { schema }, async (request, reply) => {
		const { params } = request

		const [error, payment] = await tryCatch(paymentService.completeFakeSession(params.sessionId))
		if (error instanceof FakeProviderInactive || error instanceof EntityNotFound) {
			return reply.error(404, error)
		}
		if (error) return reply.error(500, error)
		const url = `${secrets.portalUrl}/orders/${payment.orderId}?payment=success&kind=${payment.kind}&fake=1`
		return reply.redirect(url, 303)
	})
}

export default route

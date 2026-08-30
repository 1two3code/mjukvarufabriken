import { z } from 'zod'
import { PaymentSchema } from '@mf/models'
import { tryCatch } from '@mf/utils/function'

import { EntityNotFound } from '#/lib/entityError.ts'
import { FakeProviderInactive } from '#/services/paymentService.ts'

import type { FastifyContextConfig } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	params: z.object({ sessionId: z.string() }),
	response: { 200: PaymentSchema },
}

const config = { permissions: ['spec:write'] } satisfies FastifyContextConfig

/**
 * FAKE PAYMENT PROVIDER (dev/test only, active when STRIPE_SECRET_KEY is absent). The Checkout
 * "page": marks the session paid exactly like a `checkout.session.completed` webhook would and
 * returns the payment. Authenticated and org-scoped like the order — the portal calls it
 * instead of navigating to Stripe when the checkout response says `provider: 'fake'`. With
 * Stripe configured it is a 404.
 */
const route: FastifyPluginAsyncZod = async function (app) {
	const { paymentService } = app

	app.post('/bff/stripe/fake/checkout/:sessionId', { schema, config }, async (request, reply) => {
		const { params, session } = request

		const [error, payment] = await tryCatch(
			paymentService.completeFakeSession(params.sessionId, session)
		)
		if (error instanceof FakeProviderInactive || error instanceof EntityNotFound) {
			return reply.error(404, error)
		}
		if (error) return reply.error(500, error)
		return reply.send(payment)
	})
}

export default route

import { z } from 'zod'
import { CheckoutResponseSchema, OrderOperationSchemas } from '@mf/models'
import { tryCatch } from '@mf/utils/function'

import { EntityNotFound } from '#/lib/entityError.ts'
import { BalanceAwaitsPreview, PaymentNotDue } from '#/services/paymentService.ts'

import type { FastifyContextConfig } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	params: z.object({ orderId: z.string() }),
	body: OrderOperationSchemas.Checkout,
	response: { 201: CheckoutResponseSchema },
}

const config = { permissions: ['spec:write'] } satisfies FastifyContextConfig

/**
 * Starts a Checkout for the deposit (frozen order) or the balance (delivered order): 50 % of
 * the fixed price, 25 % moms as its own line. The portal sends the browser to `url`. 409
 * `balanceAwaitsPreview` when the delivered app's preview is not up — the balance is not due
 * until it is (Hasse, 2026-09-03).
 */
const route: FastifyPluginAsyncZod = async function (app) {
	const { paymentService } = app

	app.post('/bff/orders/:orderId/checkout', { schema, config }, async (request, reply) => {
		const { session, params, body } = request

		const [error, checkout] = await tryCatch(
			paymentService.checkout(params.orderId, body.kind, session)
		)
		if (error instanceof EntityNotFound) return reply.error(404, error)
		if (error instanceof BalanceAwaitsPreview) {
			return reply.error(409, error, 'balanceAwaitsPreview')
		}
		if (error instanceof PaymentNotDue) return reply.error(409, error, 'paymentNotDue')
		if (error) return reply.error(500, error)
		return reply.code(201).send(checkout)
	})
}

export default route

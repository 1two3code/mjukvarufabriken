import { z } from 'zod'
import { OrderMutationSchemas, OrderResponseSchema } from '@mf/models'
import { tryCatch } from '@mf/utils/function'

import { EntityNotFound } from '#/lib/entityError.ts'
import { DemoNotApprovable, DemoWeeklyCapReached } from '#/services/orderService.ts'

import type { FastifyContextConfig } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	params: z.object({ orderId: z.string() }),
	body: OrderMutationSchemas.ApproveBuild,
	response: { 200: OrderResponseSchema },
}

const config = { permissions: ['job:admin'] } satisfies FastifyContextConfig

/**
 * Admin approval of a paid voucher demo's build (wave 14): stamps `buildApprovedAt` and starts
 * the build exactly like the deposit webhook does for a real build. Refused with
 * `demoWeeklyCapReached` once the rolling week holds `DEMO_WEEKLY_CAP` approvals unless the body
 * says `force: true`; `demoNotApprovable` for anything but a `demo` in `deposit_paid`.
 */
const route: FastifyPluginAsyncZod = async function (app) {
	const { orderService } = app

	app.post(
		'/bff/admin/orders/:orderId/approve-build',
		{ schema, config },
		async (request, reply) => {
			const { session, params, body } = request

			const [error, order] = await tryCatch(
				orderService.approveDemoBuild(params.orderId, session, { force: body.force })
			)
			if (error instanceof EntityNotFound) return reply.error(404, error)
			if (error instanceof DemoWeeklyCapReached) {
				return reply.error(409, error, 'demoWeeklyCapReached', {
					approved: error.approved,
					cap: error.cap,
				})
			}
			if (error instanceof DemoNotApprovable) return reply.error(409, error, 'demoNotApprovable')
			if (error) return reply.error(500, error)
			return reply.send(order)
		}
	)
}

export default route

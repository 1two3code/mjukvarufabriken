import { z } from 'zod'
import { canTransitionOrder, JobResponseSchema } from '@mf/models'
import { tryCatch } from '@mf/utils/function'

import { EntityNotFound } from '#/lib/entityError.ts'
import { JobAlreadyActive, SpecNotFrozen } from '#/services/jobService.ts'

import type { FastifyContextConfig } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import type { OrderStatus } from '@mf/models'

const schema = {
	params: z.object({ orderId: z.string() }),
	response: { 201: JobResponseSchema },
}

const config = { permissions: ['job:write'] } satisfies FastifyContextConfig

/** Order statuses a customer may (re)start a build in — the deposit must be in */
const buildable = new Set<OrderStatus>(['deposit_paid', 'building'])

/**
 * Manual (re)start of a build. The webhook starts the first build when the deposit lands;
 * this route is the customer's retry (after a failed build) and the admin's override. A voucher
 * demo (wave 14) is admin-approved before its first build: until `buildApprovedAt` is set nobody
 * — admin included — can start it here; the approve-build admin route is the only way in (it
 * stamps the approval the weekly cap counts). An approved demo restarts here like any paid order.
 */
const route: FastifyPluginAsyncZod = async function (app) {
	const { jobService, orderService } = app

	app.post('/bff/orders/:orderId/jobs', { schema, config }, async (request, reply) => {
		const { session, params } = request

		const [orderError, order] = await tryCatch(orderService.get(params.orderId, session))
		if (orderError) return reply.error(orderError instanceof EntityNotFound ? 404 : 500, orderError)
		if (session.role !== 'admin' && !buildable.has(order.status)) {
			return reply.error(409, `order (${order.id}) is ${order.status}`, 'depositNotPaid')
		}
		// Admins too: a demo's FIRST start goes through approve-build, which stamps the approval
		// the weekly cap counts and the demo queue keys on — starting it here would bypass both
		if (order.kind === 'demo' && !order.buildApprovedAt) {
			return reply.error(
				409,
				`order (${order.id}) is a demo awaiting approval`,
				'demoAwaitingApproval'
			)
		}

		const [error, job] = await tryCatch(jobService.start(params.orderId, session))
		if (error instanceof SpecNotFrozen) return reply.error(409, error, 'specNotFrozen')
		if (error instanceof JobAlreadyActive) return reply.error(409, error, 'jobAlreadyActive')
		if (error) return reply.error(500, error)

		// First build (after the deposit, or an admin override from frozen): the order is now
		// building, so a delivered job later moves it to delivered (a retry is already there)
		if (canTransitionOrder(order.status, 'building')) {
			await orderService.transition(order.id, 'building').catch(transitionError => {
				app.log.warn(
					{ err: transitionError, orderId: order.id },
					'Could not mark the order building'
				)
			})
		}
		return reply.code(201).send(job)
	})
}

export default route

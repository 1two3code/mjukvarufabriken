import { z } from 'zod'
import { LifecycleActionResponseSchema, OrderMutationSchemas } from '@mf/models'
import { tryCatch } from '@mf/utils/function'

import { EntityInvalid, EntityNotFound } from '#/lib/entityError.ts'

import type { DeprovisionResult } from '@mf/org'
import type { DeprovisionSummary } from '@mf/models'
import type { FastifyContextConfig } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	params: z.object({ orderId: z.string() }),
	body: OrderMutationSchemas.LifecycleAction,
	response: { 200: LifecycleActionResponseSchema },
}

const config = { permissions: ['job:admin'] } satisfies FastifyContextConfig

/** Trim the full audited deprovision result to the summary the admin UI needs. */
const toSummary = (result: DeprovisionResult): DeprovisionSummary => ({
	mode: result.mode,
	dryRun: result.dryRun,
	discovered: result.discovered,
	fenced: result.fenced,
	skippedByFence: result.skippedByFence,
	summary: result.summary,
})

/**
 * Admin deprovisioning action on an order's delivery (wave 9, teardown-deprovisioning.md #2):
 * suspend / resume / teardown. DRY-RUN by default — pass `confirm: true` to actually deprovision
 * the tagged AWS resources and write the new lifecycle state.
 */
const route: FastifyPluginAsyncZod = async function (app) {
	const { accountService } = app

	app.post('/bff/admin/orders/:orderId/lifecycle', { schema, config }, async (request, reply) => {
		const { params, body } = request

		const [error, result] = await tryCatch(
			accountService.runLifecycleAction(params.orderId, body.action, { confirm: body.confirm })
		)
		if (error instanceof EntityNotFound) return reply.error(404, error)
		if (error instanceof EntityInvalid) return reply.error(409, error)
		if (error) return reply.error(500, error)

		return reply.send({
			action: result.action,
			dryRun: result.dryRun,
			from: result.from,
			to: result.to,
			applied: result.applied,
			order: result.order,
			...(result.deprovision && { deprovision: toSummary(result.deprovision) }),
		})
	})
}

export default route

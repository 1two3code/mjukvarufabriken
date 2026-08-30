import { InfraCostAllocationSchema } from '@mf/models'

import type { FastifyContextConfig } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	response: { 200: InfraCostAllocationSchema },
}

const config = { permissions: ['job:admin'] } satisfies FastifyContextConfig

/**
 * M12 margin calculator, phase 1 (PLAN.md): the shared platform infra estimate
 * (`sharedInfraMonthlyCostUsd`) split evenly across orgs currently active. Rough on purpose — a
 * real per-account figure replaces this once M11's vended-member-account billing ships.
 */
const route: FastifyPluginAsyncZod = async function (app) {
	const { marginService } = app

	app.get('/bff/admin/margin/infra-cost', { schema, config }, async (_request, reply) => {
		try {
			return reply.send(await marginService.infraCostAllocation())
		} catch (error) {
			return reply.error(500, error as Error)
		}
	})
}

export default route

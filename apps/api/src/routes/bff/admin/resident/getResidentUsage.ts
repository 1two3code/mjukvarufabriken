import { z } from 'zod'
import { ResidentUsageQuerySchema, ResidentUsageSummarySchema } from '@mf/models'

import type { FastifyContextConfig } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	querystring: ResidentUsageQuerySchema,
	response: { 200: z.array(ResidentUsageSummarySchema) },
}

const config = { permissions: ['job:admin'] } satisfies FastifyContextConfig

/**
 * Resident usage per installation (org) and month, newest month first, with what has been
 * reported to the payment provider for each. `?month=YYYY-MM` / `?installationId=` narrow it.
 */
const route: FastifyPluginAsyncZod = async function (app) {
	const { residentService } = app

	app.get('/bff/admin/resident/usage', { schema, config }, async (request, reply) => {
		try {
			return reply.send(await residentService.summarizeUsage(request.query))
		} catch (error) {
			return reply.error(500, error as Error)
		}
	})
}

export default route

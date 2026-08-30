import { z } from 'zod'
import { ResidentInstallationMutationSchemas, ResidentInstallationSchema } from '@mf/models'

import type { FastifyContextConfig } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	params: z.object({ id: z.string().min(1) }),
	body: ResidentInstallationMutationSchemas.UpsertInstallation,
	response: { 200: ResidentInstallationSchema },
}

const config = { permissions: ['job:admin'] } satisfies FastifyContextConfig

/**
 * Links a resident installation to its customer org and payment-provider customer (the
 * Stripe `cus_…` on the metered subscription). Creates the installation row when the
 * resident has not reported yet; `null` clears a field, an omitted field is kept.
 */
const route: FastifyPluginAsyncZod = async function (app) {
	const { residentService } = app

	app.put('/bff/admin/resident/installations/:id', { schema, config }, async (request, reply) => {
		try {
			return reply.send(await residentService.upsertInstallation(request.params.id, request.body))
		} catch (error) {
			return reply.error(500, error as Error)
		}
	})
}

export default route

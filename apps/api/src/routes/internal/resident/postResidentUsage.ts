import { ResidentUsageRecordSchema, ResidentUsageResponseSchema } from '@mf/models'
import { tryCatch } from '@mf/utils/function'

import { readBearer } from '#/routes/internal/jobs/jobToken.utils.ts'
import { ResidentUnauthorized } from '#/services/residentService.ts'

import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	body: ResidentUsageRecordSchema,
	response: { 200: ResidentUsageResponseSchema },
}

/**
 * Daily usage record from a resident installation (M8 metering). Outside `/bff` the `auth`
 * plugin does nothing: the bearer is the installation's own token (`RESIDENT_INSTALLATIONS`),
 * and the record's `installationId` must be the one the token belongs to (403 otherwise).
 * Stub for m6-orders: the record is stored, nothing is billed yet.
 */
const route: FastifyPluginAsyncZod = async function (app) {
	const { residentService } = app

	app.post('/internal/resident/usage', { schema }, async (request, reply) => {
		const [authError, installationId] = await tryCatch(
			residentService.authenticate(readBearer(request))
		)
		if (authError) {
			return reply.error(authError instanceof ResidentUnauthorized ? 401 : 500, authError)
		}
		if (request.body.installationId !== installationId) {
			return reply.error(403, 'Record belongs to another installation')
		}
		try {
			return reply.send(await residentService.recordUsage(request.body))
		} catch (error) {
			return reply.error(500, error as Error)
		}
	})
}

export default route

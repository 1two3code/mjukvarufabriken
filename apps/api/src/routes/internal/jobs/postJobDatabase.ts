import { JobDatabaseResponseSchema } from '@mf/models'
import { tryCatch } from '@mf/utils/function'

import { authenticateJobReport, jobParams } from '#/routes/internal/jobs/jobToken.utils.ts'
import { ProvisioningUnavailable } from '#/services/previewDbService.ts'

import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	params: jobParams,
	response: { 200: JobDatabaseResponseSchema },
}

/**
 * Provisions the delivered app's own database (Gate C, docs/DELIVERED-DB.md): the build
 * container asks with its per-job report token and receives ONLY the scoped connection string —
 * the admin credentials never leave the api. 503 when no admin database is configured, so the
 * job's deploy fails closed instead of shipping an app whose every read/write would 500.
 */
const route: FastifyPluginAsyncZod = async function (app) {
	app.post('/internal/jobs/:jobId/database', { schema }, async (request, reply) => {
		const job = await authenticateJobReport(app, request, reply, request.params.jobId)
		if (!job) return
		const [error, result] = await tryCatch(app.previewDbService.provision(job.id))
		if (error) return reply.error(error instanceof ProvisioningUnavailable ? 503 : 500, error)
		return reply.send(result)
	})
}

export default route

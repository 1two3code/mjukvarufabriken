import { JobStorageResponseSchema } from '@mf/models'
import { tryCatch } from '@mf/utils/function'

import { authenticateJobReport, jobParams } from '#/routes/internal/jobs/jobToken.utils.ts'
import { StorageUnavailable } from '#/services/previewStorageService.ts'

import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	params: jobParams,
	response: { 200: JobStorageResponseSchema },
}

/**
 * Provisions the delivered app's object storage (docs/PREVIEW-RESOURCES.md): its own prefix in
 * the shared preview bucket plus an IAM role scoped to exactly that prefix, which delivery then
 * passes to ECS Express as the task role. Same shape as the database route — the build container
 * asks with its per-job report token and never holds credentials of its own; only the bucket,
 * prefix and role ARN travel back. 503 when no preview bucket is configured, so a job whose app
 * needs storage fails its deploy closed instead of shipping an app whose every upload 500s.
 */
const route: FastifyPluginAsyncZod = async function (app) {
	app.post('/internal/jobs/:jobId/storage', { schema }, async (request, reply) => {
		const job = await authenticateJobReport(app, request, reply, request.params.jobId)
		if (!job) return
		const [error, result] = await tryCatch(app.previewStorageService.provision(job.id))
		if (error) return reply.error(error instanceof StorageUnavailable ? 503 : 500, error)
		return reply.send(result)
	})
}

export default route

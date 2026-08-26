import { z } from 'zod'
import { tryCatch } from '@mf/utils/function'

import { EntityNotFound } from '#/lib/entityError.ts'
import { ReportUnauthorized } from '#/services/jobService.ts'

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

/**
 * `/internal/jobs/:jobId/*` is the build container's reporting surface: no session, no
 * `/bff` JWT — the bearer is the per-job token minted by `jobService.start`. Outside `/bff`
 * the `auth` plugin does nothing, so each route authenticates through this helper.
 */
export const jobParams = z.object({ jobId: z.string() })

/**
 * Gate reports carry review findings and test output in `details`; the default 1 MiB would
 * reject the final PATCH of a large job and lose its outcome (the job only PATCHes once).
 */
export const reportBodyLimit = 8 * 1024 * 1024

export const readBearer = (request: FastifyRequest) => {
	const header = request.headers.authorization
	return header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : undefined
}

/** Resolves the job the token belongs to, or replies 401 (unknown token) / 404 (other job) */
export const authenticateJobReport = async (
	app: FastifyInstance,
	request: FastifyRequest,
	reply: FastifyReply,
	jobId: string
) => {
	const [error, job] = await tryCatch(app.jobService.authenticateReport(jobId, readBearer(request)))
	if (!error) return job
	if (error instanceof ReportUnauthorized) reply.error(401, 'Unauthorized')
	else if (error instanceof EntityNotFound) reply.error(404, error)
	else reply.error(500, error)
	return undefined
}

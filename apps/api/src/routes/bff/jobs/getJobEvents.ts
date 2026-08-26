import { z } from 'zod'
import { JobEventListResponseSchema, JobQuerySchemas } from '@mf/models'
import { tryCatch } from '@mf/utils/function'

import { EntityNotFound } from '#/lib/entityError.ts'

import type { FastifyContextConfig } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	params: z.object({ jobId: z.string() }),
	querystring: JobQuerySchemas.GetJobEvents,
	response: { 200: JobEventListResponseSchema },
}

const config = { permissions: ['job:read'] } satisfies FastifyContextConfig

/** Incremental event log: the portal polls with `after=<last id>` */
const route: FastifyPluginAsyncZod = async function (app) {
	const { jobService } = app

	app.get('/bff/jobs/:jobId/events', { schema, config }, async (request, reply) => {
		const { session, params, query } = request

		const [error, events] = await tryCatch(
			jobService.listEvents(params.jobId, query.after, session)
		)
		if (error) return reply.error(error instanceof EntityNotFound ? 404 : 500, error)
		return reply.send(events)
	})
}

export default route

import { JobListResponseSchema } from '@mf/models'

import type { FastifyContextConfig } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	response: { 200: JobListResponseSchema },
}

const config = { permissions: ['job:admin'] } satisfies FastifyContextConfig

/** Every job across orgs, newest first (admin view) */
const route: FastifyPluginAsyncZod = async function (app) {
	const { jobService } = app

	app.get('/bff/admin/jobs', { schema, config }, async (_request, reply) => {
		try {
			const jobs = await jobService.listAll()
			return reply.send(jobs)
		} catch (error) {
			return reply.error(500, error as Error)
		}
	})
}

export default route

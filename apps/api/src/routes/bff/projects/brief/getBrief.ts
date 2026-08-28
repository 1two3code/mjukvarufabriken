import { z } from 'zod'
import { IterationBriefSchema } from '@mf/models'
import { tryCatch } from '@mf/utils/function'

import { EntityNotFound } from '#/lib/entityError.ts'

import type { FastifyContextConfig } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	params: z.object({ projectId: z.string().min(1) }),
	response: { 200: IterationBriefSchema },
}

const config = { permissions: ['spec:read'] } satisfies FastifyContextConfig

/** The session org's iteration brief for the project (404 when it has none yet) */
const route: FastifyPluginAsyncZod = async function (app) {
	const { iterationBriefService } = app

	app.get('/bff/projects/:projectId/brief', { schema, config }, async (request, reply) => {
		const { session, params } = request

		const [error, brief] = await tryCatch(iterationBriefService.get(params.projectId, session))
		if (error) return reply.error(error instanceof EntityNotFound ? 404 : 500, error)
		return reply.send(brief)
	})
}

export default route

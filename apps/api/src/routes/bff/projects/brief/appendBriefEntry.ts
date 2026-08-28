import { z } from 'zod'
import { IterationBriefMutationSchemas, IterationBriefSchema } from '@mf/models'

import type { FastifyContextConfig } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	params: z.object({ projectId: z.string().min(1) }),
	body: IterationBriefMutationSchemas.AppendEntry,
	response: { 201: IterationBriefSchema },
}

const config = { permissions: ['spec:write'] } satisfies FastifyContextConfig

/**
 * Appends a question / answer / decision / context entry to the session org's brief for the
 * project (creating the brief on first contact). Returns the whole brief.
 */
const route: FastifyPluginAsyncZod = async function (app) {
	const { iterationBriefService } = app

	app.post(
		'/bff/projects/:projectId/brief/entries',
		{ schema, config },
		async (request, reply) => {
			const { session, params, body } = request

			try {
				const brief = await iterationBriefService.appendEntry(params.projectId, body, session)
				return reply.code(201).send(brief)
			} catch (error) {
				return reply.error(500, error as Error)
			}
		}
	)
}

export default route

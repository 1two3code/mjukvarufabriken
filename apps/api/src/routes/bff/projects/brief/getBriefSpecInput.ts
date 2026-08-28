import { z } from 'zod'
import { IterationBriefSpecSeedSchema } from '@mf/models'
import { tryCatch } from '@mf/utils/function'

import { EntityNotFound } from '#/lib/entityError.ts'

import type { FastifyContextConfig } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	params: z.object({ projectId: z.string().min(1) }),
	response: { 200: IterationBriefSpecSeedSchema },
}

const config = { permissions: ['spec:read'] } satisfies FastifyContextConfig

/**
 * The project's iteration brief projected into a spec-engine seed (the `@mf/harness` planner's
 * `SpecDraft`-shaped input): partial spec + open questions + decisions + context, to prime the
 * next full factory build. 404 when the project has no brief.
 */
const route: FastifyPluginAsyncZod = async function (app) {
	const { iterationBriefService } = app

	app.get(
		'/bff/projects/:projectId/brief/spec-input',
		{ schema, config },
		async (request, reply) => {
			const { session, params } = request

			const [error, seed] = await tryCatch(
				iterationBriefService.exportSpecSeed(params.projectId, session)
			)
			if (error) return reply.error(error instanceof EntityNotFound ? 404 : 500, error)
			return reply.send(seed)
		}
	)
}

export default route

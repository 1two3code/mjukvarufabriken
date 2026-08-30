import { z } from 'zod'
import { ResidentInstallationSchema } from '@mf/models'

import type { FastifyContextConfig } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	response: { 200: z.array(ResidentInstallationSchema) },
}

const config = { permissions: ['job:admin'] } satisfies FastifyContextConfig

/** Every resident installation the factory knows (seen reporting, or registered by an admin) */
const route: FastifyPluginAsyncZod = async function (app) {
	const { residentService } = app

	app.get('/bff/admin/resident/installations', { schema, config }, async (_request, reply) => {
		try {
			return reply.send(await residentService.listInstallations())
		} catch (error) {
			return reply.error(500, error as Error)
		}
	})
}

export default route

import { z } from 'zod'
import { ShowcaseAdminRowSchema } from '@mf/models'

import type { FastifyContextConfig } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	response: { 200: z.array(ShowcaseAdminRowSchema) },
}

const config = { permissions: ['job:admin'] } satisfies FastifyContextConfig

/** Every showcase row (published or draft) with its order's name/status/lifecycle, gallery order first */
const route: FastifyPluginAsyncZod = async function (app) {
	app.get('/bff/admin/showcases', { schema, config }, async (_request, reply) => {
		try {
			return reply.send(await app.showcaseService.listAdmin())
		} catch (error) {
			return reply.error(500, error as Error)
		}
	})
}

export default route

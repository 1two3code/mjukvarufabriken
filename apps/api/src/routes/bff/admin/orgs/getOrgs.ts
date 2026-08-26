import { z } from 'zod'
import { OrgSchema } from '@mf/models'

import type { FastifyContextConfig } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	response: { 200: z.array(OrgSchema) },
}

const config = { permissions: ['job:admin'] } satisfies FastifyContextConfig

/** Every customer org (admin view: names the jobs' orgs) */
const route: FastifyPluginAsyncZod = async function (app) {
	const { db } = app

	app.get('/bff/admin/orgs', { schema, config }, async (_request, reply) => {
		try {
			const orgs = await db.users.listOrgs()
			return reply.send(orgs)
		} catch (error) {
			return reply.error(500, error as Error)
		}
	})
}

export default route

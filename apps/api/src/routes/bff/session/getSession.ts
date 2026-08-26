import { FrontendSessionSchema } from '@mf/models'

import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = { response: { 200: FrontendSessionSchema } }

/** The signed-in user and their org, as the SPAs render them */
const route: FastifyPluginAsyncZod = async function (app) {
	app.get('/bff/session', { schema }, async (request, reply) => {
		const { session } = request
		try {
			const user = await app.userService.get(session.userId)
			const org = await app.userService.getOrg(user.orgId)
			return reply.send({
				userId: user.id,
				role: user.role,
				name: user.name ?? user.email,
				user,
				org,
			})
		} catch (error) {
			return reply.error(500, error as Error)
		}
	})
}

export default route

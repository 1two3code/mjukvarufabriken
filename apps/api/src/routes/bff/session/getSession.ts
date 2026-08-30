import { FrontendSessionSchema } from '@template/models'

import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = { response: { 200: FrontendSessionSchema } }

const route: FastifyPluginAsyncZod = async function (app) {
	app.get('/bff/session', { schema }, async (request, reply) => {
		const { token, session } = request
		return reply.send({ userId: session.userId, role: session.role, name: token.name ?? token.sub })
	})
}

export default route

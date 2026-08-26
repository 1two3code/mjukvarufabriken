import { z } from 'zod'
import { AuthMutationSchemas } from '@mf/models'

import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	body: AuthMutationSchemas.Logout,
	response: { 204: z.null() },
}

/** Public route. Revokes the refresh token; the access token simply expires (1h). */
const route: FastifyPluginAsyncZod = async function (app) {
	app.post('/bff/auth/logout', { schema }, async (request, reply) => {
		const { body } = request
		try {
			await app.authService.logout(body.refreshToken)
			return reply.code(204).send(null)
		} catch (error) {
			return reply.error(500, error as Error)
		}
	})
}

export default route

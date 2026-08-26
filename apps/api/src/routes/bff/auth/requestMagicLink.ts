import { z } from 'zod'
import { AuthMutationSchemas } from '@mf/models'

import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	body: AuthMutationSchemas.RequestMagicLink,
	response: { 202: z.object({}) },
}

/**
 * Public route. Always answers 202 with an empty body so the response never reveals whether
 * the address is known, rate-limited or failed to send — failures are only logged.
 */
const route: FastifyPluginAsyncZod = async function (app) {
	app.post('/bff/auth/magic-link', { schema }, async (request, reply) => {
		const { body } = request
		try {
			await app.authService.requestMagicLink(body.email)
		} catch (error) {
			request.log.error({ err: error }, 'Failed to send magic link')
		}
		return reply.code(202).send({})
	})
}

export default route

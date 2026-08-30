import { AuthMutationSchemas, TokenPairSchema } from '@mf/models'

import { EntityInvalid } from '#/lib/entityError.ts'

import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	body: AuthMutationSchemas.VerifyMagicLink,
	response: { 200: TokenPairSchema },
}

/** Public route. Consumes a magic link and returns the first token pair of the session. */
const route: FastifyPluginAsyncZod = async function (app) {
	app.post('/bff/auth/verify', { schema }, async (request, reply) => {
		const { body } = request
		try {
			const tokens = await app.authService.verifyMagicLink(body.token)
			return reply.send(tokens)
		} catch (error) {
			if (error instanceof EntityInvalid) {
				return reply.error(401, error, 'invalidMagicLink')
			}
			return reply.error(500, error as Error)
		}
	})
}

export default route

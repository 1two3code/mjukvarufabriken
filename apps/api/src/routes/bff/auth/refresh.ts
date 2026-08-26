import { AuthMutationSchemas, TokenPairSchema } from '@mf/models'

import { EntityInvalid } from '#/lib/entityError.ts'

import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	body: AuthMutationSchemas.Refresh,
	response: { 200: TokenPairSchema },
}

/**
 * Public route (see the `auth` plugin allowlist). Rotates the refresh token and returns a new
 * pair; the SPA's base query calls this on any 401 and clears the session when it fails.
 */
const route: FastifyPluginAsyncZod = async function (app) {
	app.post('/bff/auth/refresh', { schema }, async (request, reply) => {
		const { body } = request
		try {
			const tokens = await app.authService.refresh(body.refreshToken)
			return reply.send(tokens)
		} catch (error) {
			if (error instanceof EntityInvalid) return reply.error(401, error)
			return reply.error(500, error as Error)
		}
	})
}

export default route

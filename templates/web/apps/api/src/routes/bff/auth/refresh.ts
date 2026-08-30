import { z } from 'zod'

import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	body: z.object({ refreshToken: z.string() }),
	response: { 200: z.object({ token: z.string(), refreshToken: z.string() }) },
}

/**
 * Public route (see the `auth` plugin allowlist). Exchange the refresh token with
 * your identity provider here and return a new token pair. The template has no
 * identity provider configured, so it answers 501.
 */
const route: FastifyPluginAsyncZod = async function (app) {
	app.post('/bff/auth/refresh', { schema }, async (_request, reply) => {
		return reply.error(501, 'Token refresh is not configured', 'refreshNotConfigured')
	})
}

export default route

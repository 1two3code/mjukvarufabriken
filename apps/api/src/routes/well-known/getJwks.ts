import { z } from 'zod'

import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	response: {
		200: z.object({
			keys: z.array(z.record(z.string(), z.unknown())),
		}),
	},
}

/**
 * Public. The api's token-signing public key(s), so other services (and humans) can verify
 * tokens minted here. Outside /bff so the auth plugin never touches it.
 */
const route: FastifyPluginAsyncZod = async function (app) {
	app.get('/.well-known/jwks.json', { schema }, async (_request, reply) => {
		return reply.header('cache-control', 'public, max-age=3600').send(app.authKeys.jwks)
	})
}

export default route

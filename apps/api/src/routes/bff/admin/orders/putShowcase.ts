import { z } from 'zod'
import { ShowcaseMutationSchemas, ShowcaseSchema } from '@mf/models'
import { tryCatch } from '@mf/utils/function'

import { EntityNotFound } from '#/lib/entityError.ts'
import { ShowcaseNoLiveUrl } from '#/services/showcaseService.ts'

import type { FastifyContextConfig } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	params: z.object({ orderId: z.string() }),
	body: ShowcaseMutationSchemas.UpsertShowcase,
	response: { 200: ShowcaseSchema },
}

const config = { permissions: ['job:admin'] } satisfies FastifyContextConfig

/**
 * Admin marks (or edits) an order's showcase row for the public demo gallery (wave 14, F3). The
 * whole row is written: published flag, title, both blurbs, sort, and the live URL — which
 * defaults to the order's latest delivered deployUrl when left out. Publishing an order that has
 * no live URL and none supplied is refused with 409 `showcaseNoLiveUrl`.
 */
const route: FastifyPluginAsyncZod = async function (app) {
	app.put('/bff/admin/orders/:orderId/showcase', { schema, config }, async (request, reply) => {
		const { params, body } = request

		const [error, showcase] = await tryCatch(app.showcaseService.upsert(params.orderId, body))
		if (error instanceof EntityNotFound) return reply.error(404, error)
		if (error instanceof ShowcaseNoLiveUrl) return reply.error(409, error, 'showcaseNoLiveUrl')
		if (error) return reply.error(500, error)

		return reply.send(showcase)
	})
}

export default route

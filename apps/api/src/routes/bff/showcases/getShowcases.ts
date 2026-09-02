import { ShowcaseListResponseSchema } from '@mf/models'
import { tryCatch } from '@mf/utils/function'

import { clientIp } from '#/routes/bff/contact/postContact.ts'
import { ShowcaseRateLimited } from '#/services/showcaseService.ts'

import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	response: { 200: ShowcaseListResponseSchema },
}

/** How long a browser / CDN may reuse the gallery: the admin's edits show within a minute */
export const showcaseCacheControl = 'public, max-age=60'

/**
 * The public demo gallery (wave 14, F3) — listed in `publicUrls`, no session. Published
 * showcases of orders that are not torn down, in gallery order. Per-ip rate-limited like the
 * contact form (429), and cache-friendly: the body carries nothing per visitor.
 */
const route: FastifyPluginAsyncZod = async function (app) {
	app.get('/bff/showcases', { schema }, async (request, reply) => {
		const { headers, ip } = request

		const [error, items] = await tryCatch(
			app.showcaseService.listPublished(clientIp(headers['x-forwarded-for'], ip))
		)
		if (error instanceof ShowcaseRateLimited) return reply.error(429, error)
		if (error) return reply.error(500, error)

		reply.header('cache-control', showcaseCacheControl)
		return reply.send({ items })
	})
}

export default route

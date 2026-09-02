import { z } from 'zod'
import { OrderExportResponseSchema } from '@mf/models'
import { tryCatch } from '@mf/utils/function'

import { EntityNotFound } from '#/lib/entityError.ts'

import type { FastifyContextConfig } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	params: z.object({ orderId: z.string() }),
	response: { 200: OrderExportResponseSchema },
}

const config = { permissions: ['spec:read'] } satisfies FastifyContextConfig

/**
 * The order's final export (wave 14): repo zip, database dump, storage copy and — once torn
 * down — the deletion certificate, with 15-minute presigned download links (org-scoped). 404
 * until an export exists; 503 when the api has no artifacts bucket.
 */
const route: FastifyPluginAsyncZod = async function (app) {
	const { exportService, s3 } = app

	app.get('/bff/orders/:orderId/export', { schema, config }, async (request, reply) => {
		const { session, params } = request

		if (!s3.configured) return reply.error(503, new Error('export downloads unavailable'))
		const [error, exported] = await tryCatch(exportService.getForOrder(params.orderId, session))
		if (error) return reply.error(error instanceof EntityNotFound ? 404 : 500, error)
		return reply.send(exported)
	})
}

export default route

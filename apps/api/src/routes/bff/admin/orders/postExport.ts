import { z } from 'zod'
import { OrderExportSchema } from '@mf/models'
import { tryCatch } from '@mf/utils/function'

import { EntityNotFound } from '#/lib/entityError.ts'

import type { FastifyContextConfig } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	params: z.object({ orderId: z.string() }),
	response: { 200: OrderExportSchema },
}

const config = { permissions: ['job:admin'] } satisfies FastifyContextConfig

/**
 * Takes the order's final export now (wave 14) — what the hosting sweep does before a scheduled
 * teardown, for an admin who wants to tear an order down by hand: a confirmed teardown is refused
 * until the export is `done`. Idempotent: a done export is returned, not retaken.
 */
const route: FastifyPluginAsyncZod = async function (app) {
	const { exportService } = app

	app.post('/bff/admin/orders/:orderId/export', { schema, config }, async (request, reply) => {
		const { params } = request

		const [error, exported] = await tryCatch(exportService.finalExport(params.orderId))
		if (error) return reply.error(error instanceof EntityNotFound ? 404 : 500, error)
		return reply.send(exported)
	})
}

export default route

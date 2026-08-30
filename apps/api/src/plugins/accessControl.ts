import fp from 'fastify-plugin'
import { includesAllPermissions } from '@template/access-control'

import type { FastifyPluginAsync } from 'fastify'
import type { Permission } from '@template/access-control'

declare module 'fastify' {
	interface FastifyContextConfig {
		permissions?: Permission[]
	}
}

const plugin: FastifyPluginAsync = async app => {
	app.addHook('onRequest', async (request, reply) => {
		const { permissions } = request.routeOptions.config
		if (!permissions?.length) return

		const role = request.session?.role
		if (!role || !includesAllPermissions(role, permissions)) {
			return reply.error(403, 'You do not have permission to access this resource')
		}
	})
}

export default fp(plugin, {
	name: '#internal/accessControl',
	dependencies: ['#internal/auth', '#internal/errorHandling'],
})

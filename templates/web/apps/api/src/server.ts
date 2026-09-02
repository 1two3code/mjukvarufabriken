import { fastify } from 'fastify'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import cors from '@fastify/cors'

import accessControlPlugin from '#/plugins/accessControl.ts'
import authPlugin from '#/plugins/auth.ts'
import errorHandlingPlugin from '#/plugins/errorHandling.ts'
import objectStoragePlugin from '#/plugins/objectStorage.ts'
import secretsPlugin from '#/plugins/secrets.ts'
import storePlugin from '#/plugins/store.ts'
import itemService from '#/services/itemService.ts'

import type { FastifyInstance, LogLevel } from 'fastify'

type Options = { logLevel?: LogLevel }

/**
 * Composes plugins and services in dependency order. Exported so tests (and any
 * headless tooling) can build a server without listening.
 */
export async function createServer({ logLevel }: Options = {}): Promise<FastifyInstance> {
	const server = fastify({
		logger: {
			level: logLevel ?? 'info',
			redact: {
				paths: ['pid', 'hostname', 'req.host', 'req.remotePort', 'req.remoteAddress'],
				remove: true,
			},
		},
	})

	await server
		// Zod support
		.setValidatorCompiler(validatorCompiler)
		.setSerializerCompiler(serializerCompiler)

		// Third party plugins
		.register(cors, { origin: '*', methods: 'GET,PATCH,POST,DELETE' })

		// Plugins
		.register(secretsPlugin)
		.register(storePlugin)
		.register(objectStoragePlugin)

		// Services
		.register(itemService)

		// Request plugins
		.register(errorHandlingPlugin)
		.register(authPlugin)
		.register(accessControlPlugin)

	return server
}

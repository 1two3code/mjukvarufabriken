import { fastify } from 'fastify'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import cors from '@fastify/cors'

import accessControlPlugin from '#/plugins/accessControl.ts'
import anthropicPlugin from '#/plugins/anthropic.ts'
import authPlugin from '#/plugins/auth.ts'
import authKeysPlugin from '#/plugins/authKeys.ts'
import dbPlugin from '#/plugins/db.ts'
import ecsPlugin from '#/plugins/ecs.ts'
import emailPlugin from '#/plugins/email.ts'
import errorHandlingPlugin from '#/plugins/errorHandling.ts'
import secretsPlugin from '#/plugins/secrets.ts'
import storePlugin from '#/plugins/store.ts'
import authService from '#/services/authService.ts'
import itemService from '#/services/itemService.ts'
import jobService from '#/services/jobService.ts'
import specService from '#/services/specService.ts'
import userService from '#/services/userService.ts'

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
		.register(dbPlugin)
		.register(ecsPlugin)
		.register(anthropicPlugin)
		.register(authKeysPlugin)
		.register(emailPlugin)

		// Services
		.register(itemService)
		.register(specService)
		.register(jobService)
		.register(userService)
		.register(authService)

		// Request plugins
		.register(errorHandlingPlugin)
		.register(authPlugin)
		.register(accessControlPlugin)

	return server
}

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
import githubOAuthPlugin from '#/plugins/githubOAuth.ts'
import hostingSweeperPlugin from '#/plugins/hostingSweeper.ts'
import jobSweeperPlugin from '#/plugins/jobSweeper.ts'
import lifecycleSweeperPlugin from '#/plugins/lifecycleSweeper.ts'
import metricsPlugin from '#/plugins/metrics.ts'
import orgPlugin from '#/plugins/org.ts'
import prunerPlugin from '#/plugins/pruner.ts'
import s3Plugin from '#/plugins/s3.ts'
import secretsPlugin from '#/plugins/secrets.ts'
import sentryPlugin from '#/plugins/sentry.ts'
import stripePlugin from '#/plugins/stripe.ts'
import accountService from '#/services/accountService.ts'
import authService from '#/services/authService.ts'
import contactService from '#/services/contactService.ts'
import exportService from '#/services/exportService.ts'
import iterationBriefService from '#/services/iterationBriefService.ts'
import jobService from '#/services/jobService.ts'
import marginService from '#/services/marginService.ts'
import orderService from '#/services/orderService.ts'
import paymentService from '#/services/paymentService.ts'
import previewDbService from '#/services/previewDbService.ts'
import previewStorageService from '#/services/previewStorageService.ts'
import residentService from '#/services/residentService.ts'
import showcaseService from '#/services/showcaseService.ts'
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
		.register(sentryPlugin)
		.register(dbPlugin)
		.register(ecsPlugin)
		.register(s3Plugin)
		.register(metricsPlugin)
		.register(anthropicPlugin)
		.register(authKeysPlugin)
		.register(emailPlugin)
		.register(stripePlugin)
		.register(githubOAuthPlugin)
		.register(orgPlugin)
		.register(prunerPlugin)
		.register(jobSweeperPlugin)

		// Services
		.register(specService)
		.register(jobService)
		.register(previewDbService)
		.register(previewStorageService)
		.register(exportService)
		.register(userService)
		.register(authService)
		.register(contactService)
		// orderService starts builds (wave 14 demo approval) and provisions the customer account
		.register(accountService)
		.register(orderService)
		.register(residentService)
		.register(iterationBriefService)
		.register(paymentService)
		.register(marginService)
		.register(showcaseService)

		// Background schedulers depending on services
		.register(lifecycleSweeperPlugin)
		.register(hostingSweeperPlugin)

		// Request plugins
		.register(errorHandlingPlugin)
		.register(authPlugin)
		.register(accessControlPlugin)

	return server
}

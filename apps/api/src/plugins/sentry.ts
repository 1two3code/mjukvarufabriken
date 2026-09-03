import fp from 'fastify-plugin'
import * as Sentry from '@sentry/node'

import { scrubSensitiveHeaders } from '#/plugins/sentry.utils.ts'

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'

declare module 'fastify' {
	interface FastifyInstance {
		/**
		 * Error-tracking client (Sentry SaaS, free tier). Reported from the same place as the
		 * existing `reply.error` logging — never call the `@sentry/node` SDK directly elsewhere.
		 */
		sentry: {
			captureException: (error: unknown) => void
		}
	}
}

/** Stand-in used when no DSN is configured so the api boots and simply skips reporting */
const createInertClient = (): FastifyInstance['sentry'] => ({ captureException: () => {} })

const plugin: FastifyPluginAsync = async app => {
	const { sentryDsn, env } = app.secrets

	if (!sentryDsn) {
		app.log.info('Sentry DSN not configured — error tracking disabled')
		app.decorate('sentry', createInertClient())
		return
	}

	Sentry.init({ dsn: sentryDsn, environment: env, beforeSend: scrubSensitiveHeaders })
	app.decorate('sentry', { captureException: error => Sentry.captureException(error) })

	app.addHook('onClose', () => Sentry.close(2000))
}

export default fp(plugin, { name: '#internal/sentry', dependencies: ['#internal/secrets'] })

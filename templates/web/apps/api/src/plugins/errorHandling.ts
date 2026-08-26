import fp from 'fastify-plugin'
import { isObject } from '@template/utils/object'

import type { FastifyPluginAsync } from 'fastify'
import type { ApiError } from '@template/models'

type ErrorDetails = string | Error | Record<string, unknown>

declare module 'fastify' {
	interface FastifyReply {
		/**
		 * Utility function for centralized logging and sending error responses.
		 * Setting a [code] is optional and if set it's used to identify the error in the frontend.
		 * Setting [variables] is optional and provides i18n interpolation variables for the frontend.
		 */
		error: (
			status: number,
			details: ErrorDetails,
			code?: string,
			variables?: Record<string, string | number>
		) => Promise<FastifyReply>
	}
}

const extractMessage = (details: ErrorDetails, requestId: string) => {
	if (typeof details === 'string') return details
	return `Details could contain sensitive data and is therefore logged server-side: ${requestId}`
}

const parseError = (error: Error) => {
	const errObj: Record<string, unknown> = {}
	for (const key of Object.getOwnPropertyNames(error)) {
		errObj[key] = error[key as keyof Error]
	}
	return errObj
}

const extractDetails = (details: ErrorDetails) => {
	if (typeof details === 'string') return null
	if (details instanceof Error) return parseError(details)
	if (isObject(details)) return details
	return null
}

const plugin: FastifyPluginAsync = async app => {
	const { log } = app

	const logErrorResponse = (status: number, content: ApiError & Record<string, unknown>) => {
		switch (status) {
			case 403:
			case 404:
				return log.info(content)
			default:
				return log.error(content)
		}
	}

	app.decorateReply('error')

	app.addHook('onRequest', async (request, reply) => {
		reply.error = async (status, details, code, variables) => {
			const error: ApiError = {
				status,
				requestId: request.id,
				path: request.url,
				timestamp: new Date().toISOString(),
				message: extractMessage(details, request.id),
				...(code && { code }),
				...(variables && { variables }),
			}

			const logDetails = extractDetails(details)
			const userId = request.session?.userId ?? 'anonymous'

			logErrorResponse(status, {
				...error,
				...(logDetails && { details: logDetails }),
				context: { userId },
			})

			return reply.code(status).send({ error })
		}
	})

	// Catch uncaught route errors (including schema validation errors, which carry statusCode 400)
	app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
		const status = error.statusCode ?? 500
		return reply.error(status, error)
	})
}

export default fp(plugin, { name: '#internal/errorHandling' })

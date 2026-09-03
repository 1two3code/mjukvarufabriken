import type { ErrorEvent } from '@sentry/node'

/**
 * Request headers that are (or equal) a credential and must never reach Sentry: the session
 * bearer, cookies, and the anonymous quote token the site sends on every quote call (wave 14 —
 * a 500 on a quote turn would otherwise ship the visitor's proof of ownership with the event).
 * The SDK's request-data integration attaches every header by default, so `beforeSend` scrubs.
 */
export const sensitiveRequestHeaders = ['authorization', 'cookie', 'x-quote-token'] as const

/** `beforeSend` hook: the event without the sensitive request headers (lookup is case-insensitive) */
export const scrubSensitiveHeaders = (event: ErrorEvent): ErrorEvent => {
	const headers = event.request?.headers
	if (!headers) return event
	const scrubbed = Object.fromEntries(
		Object.entries(headers).filter(
			([name]) => !(sensitiveRequestHeaders as readonly string[]).includes(name.toLowerCase())
		)
	)
	return { ...event, request: { ...event.request, headers: scrubbed } }
}

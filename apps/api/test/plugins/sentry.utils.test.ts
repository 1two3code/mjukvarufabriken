import { scrubSensitiveHeaders, sensitiveRequestHeaders } from '#/plugins/sentry.utils.ts'

import type { ErrorEvent } from '@sentry/node'

describe('Sentry utils (sentry.utils)', () => {
	it('Drops the bearer, cookie and quote-token headers whatever their case, keeps the rest', () => {
		// Arrange
		const event: ErrorEvent = {
			type: undefined,
			request: {
				url: 'https://api.dev/bff/quote/o1/message',
				headers: {
					Authorization: 'Bearer secret',
					cookie: 'session=abc',
					'X-Quote-Token': 'a'.repeat(64),
					'user-agent': 'smoke',
				},
			},
		}

		// Act
		const scrubbed = scrubSensitiveHeaders(event)

		// Assert
		expect(scrubbed.request?.headers).toEqual({ 'user-agent': 'smoke' })
		expect(scrubbed.request?.url).toBe(event.request?.url)
		// The original is not mutated (Sentry may hold on to it)
		expect(Object.keys(event.request?.headers ?? {})).toHaveLength(4)
		expect(sensitiveRequestHeaders).toContain('x-quote-token')
	})

	it('Leaves an event without request data alone', () => {
		const event: ErrorEvent = { type: undefined, message: 'boom' }

		expect(scrubSensitiveHeaders(event)).toBe(event)
	})
})

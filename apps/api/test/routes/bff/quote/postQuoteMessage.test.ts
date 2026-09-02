import { EntityInvalid, EntityNotFound } from '#/lib/entityError.ts'
import { AnthropicNotConfigured } from '#/plugins/anthropic.ts'
import postQuoteMessage from '#/routes/bff/quote/postQuoteMessage.ts'
import { createMockQuote, mockQuoteToken } from '#/services/__mocks__/quoteService.ts'
import { SpecRateLimited, SpecTurnLimitReached } from '#/services/specService.ts'

import type { FastifyInstance } from 'fastify'

const url = '/bff/quote/order-1/message'
const headers = { 'x-quote-token': mockQuoteToken }
const payload = { content: 'I want a booking app' }

describe('POST /bff/quote/:orderId/message route', () => {
	let app: FastifyInstance

	beforeEach(async () => {
		app = await createTestApp()
		app.register(postQuoteMessage)
	})

	it('Runs a turn and returns the updated quote', async () => {
		// Act
		const response = await app.inject({ method: 'POST', url, headers, payload })

		// Assert
		expect(response.statusCode).toBe(200)
		expect(response.json()).toEqual(createMockQuote({ orderId: 'order-1' }))
		expect(app.quoteService.sendMessage).toHaveBeenCalledWith(
			'order-1',
			mockQuoteToken,
			payload.content,
			'127.0.0.1'
		)
	})

	it('Rejects an empty message with 400', async () => {
		// Act
		const response = await app.inject({ method: 'POST', url, headers, payload: { content: ' ' } })

		// Assert
		expect(response.statusCode).toBe(400)
		expect(app.quoteService.sendMessage).not.toHaveBeenCalled()
	})

	it('Answers 404 without a token, before any service call', async () => {
		// Act
		const response = await app.inject({ method: 'POST', url, payload })

		// Assert
		expect(response.statusCode).toBe(404)
		expect(app.quoteService.sendMessage).not.toHaveBeenCalled()
	})

	it.each([
		['404 for a wrong token', new EntityNotFound('quote', 'order-1'), 404, undefined],
		['409 specFrozen', new EntityInvalid('spec', 'order-1'), 409, 'specFrozen'],
		['409 specTurnLimit', new SpecTurnLimitReached('order-1'), 409, 'specTurnLimit'],
		['429 specRateLimited', new SpecRateLimited('order-1'), 429, 'specRateLimited'],
		['503 specEngineUnavailable', new AnthropicNotConfigured(), 503, 'specEngineUnavailable'],
		['500 specEngineFailed', new Error('boom'), 500, 'specEngineFailed'],
	])('Answers %s', async (_label, error, status, code) => {
		// Arrange
		vi.spyOn(app.quoteService, 'sendMessage').mockRejectedValueOnce(error)

		// Act
		const response = await app.inject({ method: 'POST', url, headers, payload })

		// Assert
		expect(response.statusCode).toBe(status)
		if (code) expect(response.json().error.code).toBe(code)
	})
})

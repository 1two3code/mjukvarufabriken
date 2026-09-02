import { EntityNotFound } from '#/lib/entityError.ts'
import getQuote from '#/routes/bff/quote/getQuote.ts'
import { createMockQuote, mockQuoteToken } from '#/services/__mocks__/quoteService.ts'
import { QuoteRateLimited } from '#/services/quoteService.ts'

import type { FastifyInstance } from 'fastify'

const url = '/bff/quote/order-1'
const headers = { 'x-quote-token': mockQuoteToken }

describe('GET /bff/quote/:orderId route', () => {
	let app: FastifyInstance

	beforeEach(async () => {
		app = await createTestApp()
		app.register(getQuote)
	})

	it('Returns the quote for the token in x-quote-token', async () => {
		// Act
		const response = await app.inject({ url, headers })

		// Assert
		expect(response.statusCode).toBe(200)
		expect(response.json()).toEqual(createMockQuote({ orderId: 'order-1' }))
		expect(app.quoteService.get).toHaveBeenCalledWith('order-1', mockQuoteToken, '127.0.0.1')
	})

	it.each([
		['no token header', {}],
		['a malformed token', { 'x-quote-token': 'not-hex' }],
		['a token of the wrong length', { 'x-quote-token': 'ab'.repeat(16) }],
	])('Answers 404 without calling the service for %s', async (_label, badHeaders) => {
		// Act
		const response = await app.inject({ url, headers: badHeaders })

		// Assert
		expect(response.statusCode).toBe(404)
		expect(app.quoteService.get).not.toHaveBeenCalled()
	})

	it('Answers 404 for a wrong token (indistinguishable from an unknown order)', async () => {
		// Arrange
		vi.spyOn(app.quoteService, 'get').mockRejectedValueOnce(new EntityNotFound('quote', 'order-1'))

		// Act
		const response = await app.inject({ url, headers })

		// Assert
		expect(response.statusCode).toBe(404)
	})

	it('Answers 429 quoteRateLimited when the ip reads too often', async () => {
		// Arrange
		vi.spyOn(app.quoteService, 'get').mockRejectedValueOnce(
			new QuoteRateLimited('quote-read', '127.0.0.1')
		)

		// Act
		const response = await app.inject({ url, headers })

		// Assert
		expect(response.statusCode).toBe(429)
		expect(response.json().error.code).toBe('quoteRateLimited')
	})
})

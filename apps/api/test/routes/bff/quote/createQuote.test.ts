import createQuote from '#/routes/bff/quote/createQuote.ts'
import { createMockQuote, mockQuoteToken } from '#/services/__mocks__/quoteService.ts'
import { QuoteRateLimited } from '#/services/quoteService.ts'

import type { FastifyInstance } from 'fastify'

const url = '/bff/quote'

describe('POST /bff/quote route', () => {
	let app: FastifyInstance

	beforeEach(async () => {
		app = await createTestApp()
		app.register(createQuote)
	})

	it('Creates a quote and returns it with the token, once, as 201', async () => {
		// Act
		const response = await app.inject({ method: 'POST', url, payload: { name: 'Quote' } })

		// Assert
		expect(response.statusCode).toBe(201)
		expect(response.json()).toEqual({ quote: createMockQuote(), token: mockQuoteToken })
		expect(app.quoteService.create).toHaveBeenCalledWith('127.0.0.1', 'Quote')
	})

	it('Accepts a body without a name and passes the proxy-added client ip', async () => {
		// Act
		const response = await app.inject({
			method: 'POST',
			url,
			payload: {},
			headers: { 'x-forwarded-for': 'spoof, 203.0.113.7, 130.176.0.1' },
		})

		// Assert
		expect(response.statusCode).toBe(201)
		expect(app.quoteService.create).toHaveBeenCalledWith('203.0.113.7', undefined)
	})

	it('Rejects an unknown body field with 400', async () => {
		// Act
		const response = await app.inject({ method: 'POST', url, payload: { orgId: 'org-1' } })

		// Assert
		expect(response.statusCode).toBe(400)
		expect(app.quoteService.create).not.toHaveBeenCalled()
	})

	it('Answers 429 quoteRateLimited when the ip has started too many quotes', async () => {
		// Arrange
		vi.spyOn(app.quoteService, 'create').mockRejectedValueOnce(
			new QuoteRateLimited('quote-create', '127.0.0.1')
		)

		// Act
		const response = await app.inject({ method: 'POST', url, payload: {} })

		// Assert
		expect(response.statusCode).toBe(429)
		expect(response.json().error.code).toBe('quoteRateLimited')
	})

	it('Answers 500 on other failures', async () => {
		// Arrange
		vi.spyOn(app.quoteService, 'create').mockRejectedValueOnce(new Error('db down'))

		// Act
		const response = await app.inject({ method: 'POST', url, payload: {} })

		// Assert
		expect(response.statusCode).toBe(500)
	})
})

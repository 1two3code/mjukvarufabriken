import { publicUrls } from '#/plugins/auth.ts'
import getShowcases, { showcaseCacheControl } from '#/routes/bff/showcases/getShowcases.ts'
import { createMockShowcaseItem } from '#/services/__mocks__/showcaseService.ts'
import { ShowcaseRateLimited } from '#/services/showcaseService.ts'

import type { FastifyInstance } from 'fastify'

const url = '/bff/showcases'

describe('GET /bff/showcases route', () => {
	let app: FastifyInstance

	beforeEach(async () => {
		app = await createTestApp()
		app.register(getShowcases)
	})

	it('Is a public url (no session needed on the site)', () => {
		expect(publicUrls.has(url)).toBe(true)
	})

	it('Returns the published gallery with a cache header, keyed on the client ip', async () => {
		// Arrange
		const item = createMockShowcaseItem()

		// Act
		const response = await app.inject({ url })

		// Assert
		expect(response.statusCode).toBe(200)
		expect(response.json()).toEqual({ items: [item] })
		expect(response.headers['cache-control']).toBe(showcaseCacheControl)
		expect(app.showcaseService.listPublished).toHaveBeenCalledWith('127.0.0.1')
	})

	it('Uses the proxy-added client ip, ignoring caller-supplied x-forwarded-for entries', async () => {
		// Act
		await app.inject({ url, headers: { 'x-forwarded-for': '1.2.3.4, 203.0.113.7, 130.176.0.1' } })

		// Assert
		expect(app.showcaseService.listPublished).toHaveBeenCalledWith('203.0.113.7')
	})

	it('Answers 429 when the ip is rate-limited', async () => {
		// Arrange
		vi.spyOn(app.showcaseService, 'listPublished').mockRejectedValueOnce(new ShowcaseRateLimited())

		// Act
		const response = await app.inject({ url })

		// Assert
		expect(response.statusCode).toBe(429)
	})

	it('Handles server error with 500 response', async () => {
		// Arrange
		vi.spyOn(app.showcaseService, 'listPublished').mockRejectedValueOnce(new Error('Fail'))

		// Act
		const response = await app.inject({ url })

		// Assert
		expect(response.statusCode).toBe(500)
	})
})

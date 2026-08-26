import postContact from '#/routes/bff/contact/postContact.ts'
import { createMockContactMessage } from '#/services/__mocks__/contactService.ts'

import type { FastifyInstance } from 'fastify'

const url = '/bff/contact'

describe('POST /bff/contact route', () => {
	let app: FastifyInstance

	beforeEach(async () => {
		app = await createTestApp()
		app.register(postContact)
	})

	it('Answers 202 with an empty body and forwards the message with the client ip', async () => {
		// Arrange
		const payload = createMockContactMessage()

		// Act
		const response = await app.inject({ method: 'POST', url, payload })

		// Assert
		expect(response.statusCode).toBe(202)
		expect(response.json()).toEqual({})
		expect(app.contactService.submit).toHaveBeenCalledWith(payload, '127.0.0.1')
	})

	it('Uses the first x-forwarded-for entry as the client ip behind the load balancer', async () => {
		// Act
		await app.inject({
			method: 'POST',
			url,
			payload: createMockContactMessage(),
			headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' },
		})

		// Assert
		expect(app.contactService.submit).toHaveBeenCalledWith(expect.any(Object), '203.0.113.7')
	})

	it('Omits the company when it is not given', async () => {
		// Arrange
		const { company: _company, ...payload } = createMockContactMessage()

		// Act
		const response = await app.inject({ method: 'POST', url, payload })

		// Assert
		expect(response.statusCode).toBe(202)
		expect(app.contactService.submit).toHaveBeenCalledWith(payload, expect.any(String))
	})

	it('Answers 429 with a coded error when the ip is rate-limited', async () => {
		// Arrange
		vi.spyOn(app.contactService, 'submit').mockResolvedValueOnce('rateLimited')

		// Act
		const response = await app.inject({ method: 'POST', url, payload: createMockContactMessage() })

		// Assert
		expect(response.statusCode).toBe(429)
		expect(response.json().error.code).toBe('contactRateLimited')
	})

	it('Answers 500 when sending fails', async () => {
		// Arrange
		vi.spyOn(app.contactService, 'submit').mockRejectedValueOnce(new Error('SES down'))

		// Act
		const response = await app.inject({ method: 'POST', url, payload: createMockContactMessage() })

		// Assert
		expect(response.statusCode).toBe(500)
	})

	it.each([
		['invalid email', { email: 'nope' }],
		['empty name', { name: '  ' }],
		['too short message', { message: 'Hej' }],
	])('Rejects a body with %s with 400', async (_label, overrides) => {
		// Act
		const response = await app.inject({
			method: 'POST',
			url,
			payload: createMockContactMessage(overrides),
		})

		// Assert
		expect(response.statusCode).toBe(400)
		expect(app.contactService.submit).not.toHaveBeenCalled()
	})
})

import { clientIp } from '#/routes/bff/contact/contact.utils.ts'
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

	it('Ignores caller-supplied x-forwarded-for entries and uses the proxy-added client ip', async () => {
		// Arrange: attacker puts "1.2.3.4" in the header, CloudFront appends the real client,
		// the ALB appends the CloudFront edge
		const spoofed = '1.2.3.4, 203.0.113.7, 130.176.0.1'

		// Act
		await app.inject({
			method: 'POST',
			url,
			payload: createMockContactMessage(),
			headers: { 'x-forwarded-for': spoofed },
		})

		// Assert
		expect(app.contactService.submit).toHaveBeenCalledWith(expect.any(Object), '203.0.113.7')
	})

	it.each([
		['no header → socket ip', undefined, '10.0.0.9', 2, '10.0.0.9'],
		['two hops, plain header', '203.0.113.7, 130.176.0.1', '10.0.0.9', 2, '203.0.113.7'],
		['two hops, spoofed prefix', 'x, y, 203.0.113.7, 130.176.0.1', '10.0.0.9', 2, '203.0.113.7'],
		['fewer entries than hops', '203.0.113.7', '10.0.0.9', 2, '203.0.113.7'],
		['one hop', 'spoof, 203.0.113.7', '10.0.0.9', 1, '203.0.113.7'],
		['array header', ['spoof', '203.0.113.7, 130.176.0.1'], '10.0.0.9', 2, '203.0.113.7'],
		['empty header', ' , ', '10.0.0.9', 2, '10.0.0.9'],
	])('clientIp: %s', (_label, header, fallback, hops, expected) => {
		expect(clientIp(header, fallback, hops)).toBe(expected)
	})

	it('Caps the ip key length so the limiter cannot be fed arbitrary long strings', () => {
		expect(clientIp('a'.repeat(500), '10.0.0.9', 1)).toHaveLength(64)
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

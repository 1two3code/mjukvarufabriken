import { createMockContactMessage } from '#/services/__mocks__/contactService.ts'
import { contactEmail, contactRateLimit } from '#/services/contactService.ts'

import type { FastifyInstance } from 'fastify'

const ip = '203.0.113.7'

describe('Contact Service', () => {
	let app: FastifyInstance

	beforeEach(async () => {
		app = await createTestApp({ skipMock: '#/services/contactService.ts' })
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it('Emails the message to every admin address', async () => {
		// Arrange
		app.secrets.authAdminEmails = ['a@example.com', 'b@example.com']
		const message = createMockContactMessage()

		// Act
		const result = await app.contactService.submit(message, ip)

		// Assert
		expect(result).toBe('sent')
		expect(app.email.send).toHaveBeenCalledTimes(2)
		expect(app.email.send).toHaveBeenCalledWith({ to: 'a@example.com', ...contactEmail(message) })
		expect(app.email.send).toHaveBeenCalledWith({ to: 'b@example.com', ...contactEmail(message) })
	})

	it('Puts sender details in the email and keeps header-like fields on one line', async () => {
		// Arrange
		const message = createMockContactMessage({
			name: 'Anna\nBcc: x@y.se',
			company: undefined,
			message: '  Hej!\n\nVi behöver ett system.  ',
		})

		// Act
		const email = contactEmail(message)

		// Assert
		expect(email.subject).toBe('Kontakt via mjukvaruhuset.se: Anna Bcc: x@y.se')
		expect(email.text).toBe(
			['Namn: Anna Bcc: x@y.se', 'E-post: anna@acme.se', '', 'Hej!\n\nVi behöver ett system.'].join(
				'\n'
			)
		)
	})

	it('Includes the company when given', async () => {
		// Act
		const email = contactEmail(createMockContactMessage({ company: 'Acme AB' }))

		// Assert
		expect(email.subject).toBe('Kontakt via mjukvaruhuset.se: Anna Andersson (Acme AB)')
		expect(email.text).toContain('Företag: Acme AB')
	})

	it('Drops the message with `unconfigured` when there are no admin emails', async () => {
		// Arrange
		app.secrets.authAdminEmails = []

		// Act
		const result = await app.contactService.submit(createMockContactMessage(), ip)

		// Assert
		expect(result).toBe('unconfigured')
		expect(app.email.send).not.toHaveBeenCalled()
	})

	it('Rate-limits per ip within the window and resumes after it', async () => {
		// Arrange
		vi.useFakeTimers({ toFake: ['Date'] })
		vi.setSystemTime(new Date('2026-08-26T10:00:00.000Z'))
		const message = createMockContactMessage()

		// Act
		const results = []
		for (let i = 0; i <= contactRateLimit.max; i++) {
			results.push(await app.contactService.submit(message, ip))
		}
		const otherIp = await app.contactService.submit(message, '198.51.100.9')
		vi.setSystemTime(new Date('2026-08-26T10:11:00.000Z'))
		const afterWindow = await app.contactService.submit(message, ip)

		// Assert
		expect(results).toEqual([...Array<string>(contactRateLimit.max).fill('sent'), 'rateLimited'])
		expect(otherIp).toBe('sent')
		expect(afterWindow).toBe('sent')
		expect(app.email.send).toHaveBeenCalledTimes(contactRateLimit.max + 2)
	})
})

import { createMockContactMessage } from '#/services/__mocks__/contactService.ts'
import { contactEmail, contactRateLimit, contactRateLimitScope } from '#/services/contactService.ts'

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

	it('Does not consume a rate-limit slot when the message is dropped as unconfigured', async () => {
		// Arrange
		const message = createMockContactMessage()
		app.secrets.authAdminEmails = []
		for (let i = 0; i < contactRateLimit.max; i++) await app.contactService.submit(message, ip)
		app.secrets.authAdminEmails = ['a@example.com']

		// Act
		const result = await app.contactService.submit(message, ip)

		// Assert
		expect(result).toBe('sent')
	})

	it('Counts a send attempt even when every recipient fails, so a failing mailer cannot be retried without limit', async () => {
		// Arrange
		const message = createMockContactMessage()
		vi.spyOn(app.email, 'send').mockRejectedValue(new Error('SES down'))
		for (let i = 0; i < contactRateLimit.max; i++) {
			await expect(app.contactService.submit(message, ip)).rejects.toThrow('SES down')
		}
		vi.spyOn(app.email, 'send').mockResolvedValue(undefined)

		// Act
		const result = await app.contactService.submit(message, ip)

		// Assert
		expect(result).toBe('rateLimited')
		expect(app.email.send).toHaveBeenCalledTimes(contactRateLimit.max)
	})

	it('Records the hit before the email goes out, so a failed record never follows a delivered message', async () => {
		// Arrange
		const order: string[] = []
		vi.spyOn(app.db.rateLimits, 'record').mockImplementation(async () => {
			order.push('record')
		})
		vi.spyOn(app.email, 'send').mockImplementation(async () => {
			order.push('send')
		})

		// Act
		await app.contactService.submit(createMockContactMessage(), ip)

		// Assert
		expect(order).toEqual(['record', 'send'])
	})

	it('Surfaces a failed record without sending anything (nothing to duplicate on retry)', async () => {
		// Arrange
		vi.spyOn(app.db.rateLimits, 'record').mockRejectedValue(new Error('connection reset'))

		// Act + Assert
		await expect(app.contactService.submit(createMockContactMessage(), ip)).rejects.toThrow(
			'connection reset'
		)
		expect(app.email.send).not.toHaveBeenCalled()
	})

	it('Keeps working with a process-local limiter when the database is configured but unavailable', async () => {
		// Arrange: what the db plugin decorates when the secret is unreadable or migrations failed
		const unavailable = () => Promise.reject(new Error('Database unavailable: migrations failed'))
		app.db.available = false
		vi.spyOn(app.db.rateLimits, 'count').mockImplementation(unavailable)
		vi.spyOn(app.db.rateLimits, 'record').mockImplementation(unavailable)
		const logWarn = vi.spyOn(app.log, 'warn')
		const message = createMockContactMessage()

		// Act
		const results = []
		for (let i = 0; i <= contactRateLimit.max; i++) {
			results.push(await app.contactService.submit(message, ip))
		}

		// Assert
		expect(results).toEqual([...Array<string>(contactRateLimit.max).fill('sent'), 'rateLimited'])
		expect(app.email.send).toHaveBeenCalledTimes(contactRateLimit.max)
		expect(logWarn).toHaveBeenCalledWith(expect.stringMatching(/process-local/))
	})

	it('Counts as sent when at least one admin got the email and logs the failed recipient', async () => {
		// Arrange
		app.secrets.authAdminEmails = ['a@example.com', 'b@example.com']
		vi.spyOn(app.email, 'send').mockImplementation(async ({ to }) => {
			if (to === 'b@example.com') throw new Error('bounced')
		})
		const logError = vi.spyOn(app.log, 'error')

		// Act
		const result = await app.contactService.submit(createMockContactMessage(), ip)

		// Assert
		expect(result).toBe('sent')
		expect(logError).toHaveBeenCalledWith(
			expect.objectContaining({ to: 'b@example.com' }),
			expect.any(String)
		)
	})

	it('Throws when every recipient fails', async () => {
		// Arrange
		app.secrets.authAdminEmails = ['a@example.com', 'b@example.com']
		vi.spyOn(app.email, 'send').mockRejectedValue(new Error('SES down'))

		// Act + Assert
		await expect(app.contactService.submit(createMockContactMessage(), ip)).rejects.toThrow(
			'SES down'
		)
	})

	it('Logs only the sender address, never the message body, when dropping a message', async () => {
		// Arrange
		app.secrets.authAdminEmails = []
		const logError = vi.spyOn(app.log, 'error')
		const message = createMockContactMessage({ message: 'Hemligt projekt, ring mig på 070.' })

		// Act
		await app.contactService.submit(message, ip)

		// Assert
		expect(logError).toHaveBeenCalledTimes(1)
		expect(JSON.stringify(logError.mock.calls[0])).not.toContain('Hemligt')
		expect(logError).toHaveBeenCalledWith({ from: message.email }, expect.any(String))
	})

	describe('Rate limiter', () => {
		it('Counts send attempts in the shared rate-limit repository under the contact scope', async () => {
			// Arrange
			vi.useFakeTimers({ toFake: ['Date'] })
			vi.setSystemTime(new Date('2026-08-26T10:00:00.000Z'))
			const record = vi.spyOn(app.db.rateLimits, 'record')

			// Act
			await app.contactService.submit(createMockContactMessage(), ip)

			// Assert
			expect(record).toHaveBeenCalledWith(contactRateLimitScope, ip, new Date())
		})

		it('Applies a global ceiling regardless of ip', async () => {
			// Arrange
			vi.useFakeTimers({ toFake: ['Date'] })
			vi.setSystemTime(new Date('2026-08-26T10:00:00.000Z'))
			const now = new Date()
			for (let i = 0; i < contactRateLimit.globalMax; i++) {
				await app.db.rateLimits.record(contactRateLimitScope, `10.1.${i}.1`, now)
			}
			const message = createMockContactMessage()

			// Act
			const limited = await app.contactService.submit(message, '198.51.100.1')
			vi.setSystemTime(new Date('2026-08-26T10:11:00.000Z'))
			const afterWindow = await app.contactService.submit(message, '198.51.100.1')

			// Assert
			expect(limited).toBe('rateLimited')
			expect(afterWindow).toBe('sent')
			expect(app.email.send).toHaveBeenCalledTimes(1)
		})
	})
})

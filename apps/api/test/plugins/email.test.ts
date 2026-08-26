// Clearly mocked: no real SES calls are made in this suite.
const sendMock = vi.hoisted(() => vi.fn())
vi.mock('@aws-sdk/client-sesv2', () => ({
	SESv2Client: class {
		send = sendMock
		destroy = vi.fn()
	},
	SendEmailCommand: class {
		constructor(public input: unknown) {}
	},
}))

const createApp = async (transport: string) => {
	vi.stubEnv('AUTH_AUDIENCE', 'audience')
	vi.stubEnv('EMAIL_TRANSPORT', transport)
	vi.stubEnv('AUTH_EMAIL_FROM', 'noreply@example.com')
	vi.stubEnv('ANTHROPIC_API_KEY', '')
	vi.stubEnv('ANTHROPIC_API_KEY_SECRET_ARN', '')
	vi.stubEnv('AUTH_JWT_PRIVATE_KEY_SECRET_ARN', '')
	vi.doUnmock('#/plugins/secrets.ts')
	vi.resetModules()
	return createTestApp({ skipMock: ['#/plugins/email.ts', '#/plugins/secrets.ts'] })
}

const message = { to: 'anna@example.com', subject: 'Hi', text: 'Hello', html: '<p>Hello</p>' }

describe('Email plugin (email)', () => {
	beforeEach(() => {
		sendMock.mockReset()
	})

	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it('Logs the message instead of sending with the log transport', async () => {
		// Arrange
		const app = await createApp('log')
		const info = vi.spyOn(app.log, 'info')

		// Act
		await app.email.send(message)

		// Assert
		expect(sendMock).not.toHaveBeenCalled()
		expect(info).toHaveBeenCalledWith({ email: message }, expect.stringContaining(message.to))
	})

	it('Sends through SES v2 with the ses transport', async () => {
		// Arrange
		const app = await createApp('ses')
		sendMock.mockResolvedValue({ MessageId: 'm-1' })

		// Act
		await app.email.send(message)

		// Assert
		expect(sendMock).toHaveBeenCalledWith({
			input: {
				FromEmailAddress: 'noreply@example.com',
				Destination: { ToAddresses: ['anna@example.com'] },
				Content: {
					Simple: {
						Subject: { Data: 'Hi', Charset: 'UTF-8' },
						Body: {
							Text: { Data: 'Hello', Charset: 'UTF-8' },
							Html: { Data: '<p>Hello</p>', Charset: 'UTF-8' },
						},
					},
				},
			},
		})
	})

	it('Rejects an unknown transport at boot', async () => {
		// Act & Assert
		await expect(createApp('pigeon')).rejects.toThrow('EMAIL_TRANSPORT must be one of')
	})
})

const initMock = vi.hoisted(() => vi.fn())
const captureExceptionMock = vi.hoisted(() => vi.fn())
const closeMock = vi.hoisted(() => vi.fn())
vi.mock('@sentry/node', () => ({
	init: initMock,
	captureException: captureExceptionMock,
	close: closeMock,
}))

describe('Sentry plugin (sentry)', () => {
	beforeEach(() => {
		initMock.mockClear()
		captureExceptionMock.mockClear()
		closeMock.mockClear()
	})

	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it('Initializes the SDK when a DSN is configured', async () => {
		// Arrange (the secrets mock provides a test DSN)
		// Act
		const app = await createTestApp({ skipMock: '#/plugins/sentry.ts' })
		app.sentry.captureException(new Error('boom'))

		// Assert
		expect(initMock).toHaveBeenCalledWith({
			dsn: app.secrets.sentryDsn,
			environment: app.secrets.env,
		})
		expect(captureExceptionMock).toHaveBeenCalledWith(new Error('boom'))
	})

	it('Decorates an inert client that skips reporting when no DSN is configured', async () => {
		// Arrange — real secrets plugin without any Sentry configuration
		vi.stubEnv('AUTH_AUDIENCE', 'audience')
		vi.stubEnv('SENTRY_DSN', '')
		vi.stubEnv('SENTRY_DSN_SECRET_ARN', '')
		vi.doUnmock('#/plugins/secrets.ts')
		vi.resetModules()

		// Act
		const app = await createTestApp({ skipMock: ['#/plugins/sentry.ts', '#/plugins/secrets.ts'] })
		app.sentry.captureException(new Error('boom'))

		// Assert
		expect(app.secrets.sentryDsn).toBeUndefined()
		expect(initMock).not.toHaveBeenCalled()
		expect(captureExceptionMock).not.toHaveBeenCalled()
	})
})

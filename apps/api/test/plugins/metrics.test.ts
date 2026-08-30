// Clearly mocked: no real AWS calls are made in this suite.
const sendMock = vi.hoisted(() => vi.fn())
vi.mock('@aws-sdk/client-cloudwatch', () => ({
	CloudWatchClient: class {
		send = sendMock
		destroy = vi.fn()
	},
	PutMetricDataCommand: class {
		input: unknown
		constructor(input: unknown) {
			this.input = input
		}
	},
}))

/** Real secrets + metrics plugins; everything else mocked */
const createApp = async (env: string) => {
	vi.stubEnv('AUTH_AUDIENCE', 'audience')
	vi.stubEnv('ANTHROPIC_API_KEY', '')
	vi.stubEnv('ANTHROPIC_API_KEY_SECRET_ARN', '')
	vi.stubEnv('AUTH_JWT_PRIVATE_KEY_SECRET_ARN', '')
	vi.stubEnv('ENV', env)
	vi.doUnmock('#/plugins/secrets.ts')
	vi.resetModules()
	return createTestApp({ skipMock: ['#/plugins/metrics.ts', '#/plugins/secrets.ts'] })
}

describe('Metrics plugin (metrics)', () => {
	beforeEach(() => sendMock.mockReset())
	afterEach(() => vi.unstubAllEnvs())

	it('Publishes JobsFailed as a Count into the mf/<env> namespace', async () => {
		// Arrange
		const app = await createApp('dev')
		sendMock.mockResolvedValue({})

		// Act
		await app.metrics.recordJobFailed('job-1')

		// Assert
		expect(sendMock.mock.calls[0]![0].input).toEqual({
			Namespace: 'mf/dev',
			MetricData: [{ MetricName: 'JobsFailed', Value: 1, Unit: 'Count' }],
		})
	})

	it('Publishes JobTokensUsed with the reported value, namespaced per environment', async () => {
		// Arrange
		const app = await createApp('live')
		sendMock.mockResolvedValue({})

		// Act
		await app.metrics.recordJobTokensUsed('job-1', 42_000)

		// Assert
		expect(sendMock.mock.calls[0]![0].input).toEqual({
			Namespace: 'mf/live',
			MetricData: [{ MetricName: 'JobTokensUsed', Value: 42_000, Unit: 'None' }],
		})
	})

	it('Swallows a publish failure instead of throwing — a report must never fail over a metric', async () => {
		// Arrange
		const app = await createApp('dev')
		sendMock.mockRejectedValueOnce(new Error('CloudWatch unavailable'))

		// Act / Assert
		await expect(app.metrics.recordJobFailed('job-1')).resolves.toBeUndefined()
	})
})

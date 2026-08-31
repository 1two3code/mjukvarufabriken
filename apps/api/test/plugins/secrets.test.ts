// Clearly mocked: no real AWS calls are made in this suite.
const sendMock = vi.hoisted(() => vi.fn())
vi.mock('@aws-sdk/client-secrets-manager', () => ({
	SecretsManagerClient: class {
		send = sendMock
		destroy = vi.fn()
	},
	GetSecretValueCommand: class {
		input: unknown
		constructor(input: unknown) {
			this.input = input
		}
	},
}))

const stubRequiredEnv = () => {
	vi.stubEnv('AUTH_ISSUER', 'https://api.example.com')
	vi.stubEnv('AUTH_AUDIENCE', 'audience')
	vi.stubEnv('ANTHROPIC_API_KEY', '')
	vi.stubEnv('ANTHROPIC_API_KEY_SECRET_ARN', '')
	vi.stubEnv('AUTH_JWT_PRIVATE_KEY', '')
	vi.stubEnv('AUTH_JWT_PRIVATE_KEY_SECRET_ARN', '')
	vi.stubEnv('ENV', '')
	vi.stubEnv('EMAIL_TRANSPORT', '')
}

describe('Secrets plugin (secrets)', () => {
	beforeEach(() => {
		sendMock.mockReset()
	})

	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it('Reads configuration from the environment', async () => {
		// Arrange
		stubRequiredEnv()
		vi.stubEnv('APP_URL', 'https://app.example.com')
		vi.stubEnv('ARTIFACTS_BUCKET', 'mf-artifacts')
		vi.stubEnv('JOB_SUBNET_IDS', 'subnet-a,subnet-b')
		vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-env')
		vi.stubEnv('SPEC_MODEL', 'claude-opus-5')
		vi.stubEnv('ENV', 'dev')
		vi.stubEnv('PORTAL_URL', 'https://portal.example.com')
		vi.stubEnv('AUTH_ADMIN_EMAILS', 'Hasse@Example.com, anna@example.com,')
		vi.stubEnv('AUTH_JWT_PRIVATE_KEY', '{"kty":"OKP"}')
		vi.stubEnv('AUTH_EMAIL_FROM', 'hello@example.com')
		vi.stubEnv('RESIDENT_INSTALLATIONS', 'acme-shop:tok-a, beta-crm:tok:b,broken,')
		vi.stubEnv('RESIDENT_USAGE_PRICE_ID', 'price_123')

		// Act
		const app = await createTestApp({ skipMock: '#/plugins/secrets.ts' })

		// Assert
		expect(app.secrets).toEqual({
			env: 'dev',
			appUrl: 'https://app.example.com',
			portalUrl: 'https://portal.example.com',
			authIssuer: 'https://api.example.com',
			authAudience: 'audience',
			authJwtPrivateKey: '{"kty":"OKP"}',
			authAdminEmails: ['hasse@example.com', 'anna@example.com'],
			emailTransport: 'log',
			emailFrom: 'hello@example.com',
			anthropicApiKey: 'sk-ant-env',
			specModel: 'claude-opus-5',
			sentryDsn: undefined,
			residentInstallations: { 'acme-shop': 'tok-a', 'beta-crm': 'tok:b' },
			residentBilling: { meterEvent: 'resident_usage_usd_cents', priceId: 'price_123' },
			provisionAccounts: false,
			preview: { tokenAudience: 'preview', dbAdminUrl: undefined, dbHost: undefined },
			orgLifecycle: { enabled: false, region: 'eu-north-1', customersOuId: undefined, graceDays: 30 },
			infra: expect.objectContaining({
				artifactsBucket: 'mf-artifacts',
				jobSubnetIds: ['subnet-a', 'subnet-b'],
			}),
		})
		expect(sendMock).not.toHaveBeenCalled()
	})

	it('Throws when required environment variables are missing', async () => {
		// Arrange
		vi.stubEnv('AUTH_AUDIENCE', '')

		// Act & Assert
		await expect(createTestApp({ skipMock: '#/plugins/secrets.ts' })).rejects.toThrow(
			'Missing required environment variables: AUTH_AUDIENCE'
		)
	})

	it('Defaults the issuer, portal url, email settings and admin list', async () => {
		// Arrange
		stubRequiredEnv()
		vi.stubEnv('AUTH_ISSUER', '')
		vi.stubEnv('PORTAL_URL', '')
		vi.stubEnv('APP_URL', '')
		vi.stubEnv('PORT', '')
		vi.stubEnv('AUTH_ADMIN_EMAILS', '')
		vi.stubEnv('AUTH_EMAIL_FROM', '')

		// Act
		const app = await createTestApp({ skipMock: '#/plugins/secrets.ts' })

		// Assert
		expect(app.secrets).toMatchObject({
			env: 'local',
			portalUrl: 'http://localhost:5173',
			authIssuer: 'http://localhost:5174',
			authAdminEmails: [],
			emailTransport: 'log',
			emailFrom: 'noreply@mjukvaruhuset.se',
		})
	})

	it('Defaults the email transport to ses in live', async () => {
		// Arrange
		stubRequiredEnv()
		vi.stubEnv('ENV', 'live')

		// Act
		const app = await createTestApp({ skipMock: '#/plugins/secrets.ts' })

		// Assert
		expect(app.secrets.emailTransport).toBe('ses')
	})

	it('Resolves the JWT private key from Secrets Manager and keeps multi-key JSON intact', async () => {
		// Arrange
		stubRequiredEnv()
		vi.stubEnv('AUTH_JWT_PRIVATE_KEY_SECRET_ARN', 'arn:jwk')
		const jwk = '{"kty":"OKP","crv":"Ed25519","x":"abc","d":"def"}'
		sendMock.mockResolvedValue({ SecretString: jwk })

		// Act
		const app = await createTestApp({ skipMock: '#/plugins/secrets.ts' })

		// Assert
		expect(sendMock).toHaveBeenCalledWith({ input: { SecretId: 'arn:jwk' } })
		expect(app.secrets.authJwtPrivateKey).toBe(jwk)
	})

	it('Leaves the Anthropic key undefined when neither env nor ARN is set', async () => {
		// Arrange
		stubRequiredEnv()

		// Act
		const app = await createTestApp({ skipMock: '#/plugins/secrets.ts' })

		// Assert
		expect(app.secrets.anthropicApiKey).toBeUndefined()
		expect(sendMock).not.toHaveBeenCalled()
	})

	it('Resolves the Anthropic key from Secrets Manager via ANTHROPIC_API_KEY_SECRET_ARN', async () => {
		// Arrange
		stubRequiredEnv()
		vi.stubEnv('ANTHROPIC_API_KEY_SECRET_ARN', 'arn:aws:secretsmanager:eu-north-1:1:secret:key')
		sendMock.mockResolvedValue({ SecretString: 'sk-ant-from-secrets-manager' })

		// Act
		const app = await createTestApp({ skipMock: '#/plugins/secrets.ts' })

		// Assert
		expect(sendMock).toHaveBeenCalledWith({
			input: { SecretId: 'arn:aws:secretsmanager:eu-north-1:1:secret:key' },
		})
		expect(app.secrets.anthropicApiKey).toBe('sk-ant-from-secrets-manager')
	})

	it('Unwraps single-key JSON secrets and treats empty placeholders as unset', async () => {
		// Arrange
		stubRequiredEnv()
		vi.stubEnv('ANTHROPIC_API_KEY_SECRET_ARN', 'arn:placeholder')
		sendMock.mockResolvedValueOnce({ SecretString: '{"ANTHROPIC_API_KEY":"sk-ant-json"}' })
		sendMock.mockResolvedValueOnce({ SecretString: '{"ANTHROPIC_API_KEY":""}' })

		// Act
		const json = await createTestApp({ skipMock: '#/plugins/secrets.ts' })
		const placeholder = await createTestApp({ skipMock: '#/plugins/secrets.ts' })

		// Assert
		expect(json.secrets.anthropicApiKey).toBe('sk-ant-json')
		expect(placeholder.secrets.anthropicApiKey).toBeUndefined()
	})

	it('Leaves the Sentry DSN undefined when neither env nor ARN is set', async () => {
		// Arrange
		stubRequiredEnv()

		// Act
		const app = await createTestApp({ skipMock: '#/plugins/secrets.ts' })

		// Assert
		expect(app.secrets.sentryDsn).toBeUndefined()
	})

	it('Resolves the Sentry DSN from Secrets Manager via SENTRY_DSN_SECRET_ARN', async () => {
		// Arrange
		stubRequiredEnv()
		vi.stubEnv('SENTRY_DSN_SECRET_ARN', 'arn:aws:secretsmanager:eu-north-1:1:secret:sentry')
		sendMock.mockResolvedValue({ SecretString: 'https://public@o0.ingest.sentry.io/1' })

		// Act
		const app = await createTestApp({ skipMock: '#/plugins/secrets.ts' })

		// Assert
		expect(sendMock).toHaveBeenCalledWith({
			input: { SecretId: 'arn:aws:secretsmanager:eu-north-1:1:secret:sentry' },
		})
		expect(app.secrets.sentryDsn).toBe('https://public@o0.ingest.sentry.io/1')
	})

	it('Boots without a key when Secrets Manager fails', async () => {
		// Arrange
		stubRequiredEnv()
		vi.stubEnv('ANTHROPIC_API_KEY_SECRET_ARN', 'arn:broken')
		sendMock.mockRejectedValue(new Error('AccessDenied'))

		// Act
		const app = await createTestApp({ skipMock: '#/plugins/secrets.ts' })

		// Assert
		expect(app.secrets.anthropicApiKey).toBeUndefined()
	})
})

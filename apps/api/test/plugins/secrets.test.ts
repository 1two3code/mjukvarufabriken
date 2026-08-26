// Clearly mocked: no real AWS calls are made in this suite.
const sendMock = vi.hoisted(() => vi.fn())
vi.mock('@aws-sdk/client-secrets-manager', () => ({
	SecretsManagerClient: class {
		send = sendMock
		destroy = vi.fn()
	},
	GetSecretValueCommand: class {
		constructor(public input: unknown) {}
	},
}))

const stubRequiredEnv = () => {
	vi.stubEnv('AUTH_JWKS_URL', 'https://auth.example.com/jwks')
	vi.stubEnv('AUTH_ISSUER', 'https://auth.example.com')
	vi.stubEnv('AUTH_AUDIENCE', 'audience')
	vi.stubEnv('ANTHROPIC_API_KEY', '')
	vi.stubEnv('ANTHROPIC_API_KEY_SECRET_ARN', '')
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

		// Act
		const app = await createTestApp({ skipMock: '#/plugins/secrets.ts' })

		// Assert
		expect(app.secrets).toEqual({
			appUrl: 'https://app.example.com',
			authJwksUrl: 'https://auth.example.com/jwks',
			authIssuer: 'https://auth.example.com',
			authAudience: 'audience',
			anthropicApiKey: 'sk-ant-env',
			specModel: 'claude-opus-5',
			infra: expect.objectContaining({
				artifactsBucket: 'mf-artifacts',
				jobSubnetIds: ['subnet-a', 'subnet-b'],
			}),
		})
		expect(sendMock).not.toHaveBeenCalled()
	})

	it('Throws when required environment variables are missing', async () => {
		// Arrange
		vi.stubEnv('AUTH_JWKS_URL', '')
		vi.stubEnv('AUTH_ISSUER', 'https://auth.example.com')
		vi.stubEnv('AUTH_AUDIENCE', '')

		// Act & Assert
		await expect(createTestApp({ skipMock: '#/plugins/secrets.ts' })).rejects.toThrow(
			'Missing required environment variables: AUTH_JWKS_URL, AUTH_AUDIENCE'
		)
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

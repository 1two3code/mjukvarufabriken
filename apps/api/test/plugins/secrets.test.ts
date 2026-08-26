describe('Secrets plugin (secrets)', () => {
	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it('Reads configuration from the environment', async () => {
		// Arrange
		vi.stubEnv('APP_URL', 'https://app.example.com')
		vi.stubEnv('AUTH_JWKS_URL', 'https://auth.example.com/jwks')
		vi.stubEnv('AUTH_ISSUER', 'https://auth.example.com')
		vi.stubEnv('AUTH_AUDIENCE', 'audience')
		vi.stubEnv('ARTIFACTS_BUCKET', 'mf-artifacts')
		vi.stubEnv('JOB_SUBNET_IDS', 'subnet-a,subnet-b')

		// Act
		const app = await createTestApp({ skipMock: '#/plugins/secrets.ts' })

		// Assert
		expect(app.secrets).toEqual({
			appUrl: 'https://app.example.com',
			authJwksUrl: 'https://auth.example.com/jwks',
			authIssuer: 'https://auth.example.com',
			authAudience: 'audience',
			infra: expect.objectContaining({
				artifactsBucket: 'mf-artifacts',
				jobSubnetIds: ['subnet-a', 'subnet-b'],
			}),
		})
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
})

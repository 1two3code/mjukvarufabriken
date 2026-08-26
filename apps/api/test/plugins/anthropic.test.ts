import { AnthropicNotConfigured } from '#/plugins/anthropic.ts'

describe('Anthropic plugin (anthropic)', () => {
	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it('Creates an SDK client when a key is configured', async () => {
		// Arrange (the secrets mock provides a test key)
		// Act
		const app = await createTestApp({ skipMock: '#/plugins/anthropic.ts' })

		// Assert
		expect(app.anthropic.constructor.name).toBe('Anthropic')
		expect(typeof app.anthropic.messages.create).toBe('function')
	})

	it('Decorates an unavailable client that rejects every call when no key is configured', async () => {
		// Arrange — real secrets plugin without any Anthropic configuration
		vi.stubEnv('AUTH_JWKS_URL', 'https://auth.example.com/jwks')
		vi.stubEnv('AUTH_ISSUER', 'https://auth.example.com')
		vi.stubEnv('AUTH_AUDIENCE', 'audience')
		vi.stubEnv('ANTHROPIC_API_KEY', '')
		vi.stubEnv('ANTHROPIC_API_KEY_SECRET_ARN', '')
		vi.doUnmock('#/plugins/secrets.ts')
		vi.resetModules()

		// Act
		const app = await createTestApp({
			skipMock: ['#/plugins/anthropic.ts', '#/plugins/secrets.ts'],
		})

		// Assert
		expect(app.secrets.anthropicApiKey).toBeUndefined()
		await expect(
			app.anthropic.messages.create({ model: 'x', max_tokens: 1, messages: [] })
		).rejects.toThrow(new AnthropicNotConfigured().message)
	})
})

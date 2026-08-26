import { loadConfig, parseSecretString, placeholderSecretKey } from '#/config.ts'

describe('config', () => {
	it('Treats the CDK placeholder secret as not configured, keeps real values', () => {
		expect(parseSecretString('sk-ant-real ')).toBe('sk-ant-real')
		expect(parseSecretString('{"github-token":"ghp_real"}')).toBe('ghp_real')
		expect(
			parseSecretString(
				JSON.stringify({ [placeholderSecretKey]: 'fill via put-secret-value', 'github-token': 'r4nd0m' })
			)
		).toBe('')
		expect(parseSecretString('{"a":"1","b":"2"}')).toBe('{"a":"1","b":"2"}')
		expect(parseSecretString('')).toBe('')
	})

	it('Leaves the factory reporter unconfigured without a token, even with FACTORY_API_URL set', async () => {
		const config = await loadConfig({
			GITHUB_REPOSITORY: 'acme/shop',
			FACTORY_API_URL: 'https://api.example',
			FACTORY_TOKEN: '  ',
		})
		expect(config.factory).toBeUndefined()
		expect(config.githubToken).toBeUndefined()
		expect(config.installationId).toBe('acme--shop')
	})
})

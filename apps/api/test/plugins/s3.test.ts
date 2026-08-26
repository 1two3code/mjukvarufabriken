/** Real secrets + s3 plugins; everything else mocked. Presigning is local (SigV4), no AWS call. */
const createApp = async (bucket: string) => {
	vi.stubEnv('AUTH_AUDIENCE', 'audience')
	vi.stubEnv('ANTHROPIC_API_KEY', '')
	vi.stubEnv('ANTHROPIC_API_KEY_SECRET_ARN', '')
	vi.stubEnv('AUTH_JWT_PRIVATE_KEY_SECRET_ARN', '')
	vi.stubEnv('ARTIFACTS_BUCKET', bucket)
	vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIATEST')
	vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'secret')
	vi.stubEnv('AWS_REGION', 'eu-north-1')
	vi.doUnmock('#/plugins/secrets.ts')
	vi.resetModules()
	return createTestApp({ skipMock: ['#/plugins/s3.ts', '#/plugins/secrets.ts'] })
}

describe('S3 plugin (s3)', () => {
	afterEach(() => vi.unstubAllEnvs())

	it('Presigns a 15-minute GET URL on the artifacts bucket', async () => {
		// Arrange
		const app = await createApp('mf-artifacts-test')

		// Act
		const url = new URL(await app.s3.presignDownload('deliverables/job-1/repo.zip'))

		// Assert
		expect(app.s3.configured).toBe(true)
		expect(url.host).toBe('mf-artifacts-test.s3.eu-north-1.amazonaws.com')
		expect(url.pathname).toBe('/deliverables/job-1/repo.zip')
		expect(url.searchParams.get('X-Amz-Expires')).toBe('900')
		expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)
	})

	it('Is unconfigured without a bucket and refuses to presign', async () => {
		// Arrange
		const app = await createApp('')

		// Act + Assert
		expect(app.s3.configured).toBe(false)
		await expect(app.s3.presignDownload('x')).rejects.toThrow(/ARTIFACTS_BUCKET/)
	})
})

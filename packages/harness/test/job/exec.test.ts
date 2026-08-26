import { exec, sandboxEnv } from '#job/exec.ts'

describe('exec', () => {
	it('sandboxEnv strips credentials and cloud config but keeps what the tools need', () => {
		const env = sandboxEnv({
			PATH: '/usr/bin',
			HOME: '/home/job',
			ANTHROPIC_API_KEY: 'sk-ant',
			HTTPS_PROXY: 'http://127.0.0.1:8888',
			NO_PROXY: 'localhost',
			GIT_AUTHOR_NAME: 'build',
			DATABASE_URL: 'postgres://mf:mf@postgres/mf',
			DATABASE_SECRET_ARN: 'arn:secret:rds',
			ANTHROPIC_API_KEY_SECRET_ARN: 'arn:secret:anthropic',
			AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/uuid',
			AWS_REGION: 'eu-north-1',
			ECS_CONTAINER_METADATA_URI_V4: 'http://169.254.170.2/v4',
			ARTIFACTS_BUCKET: 'mf-artifacts',
		})

		expect(env).toEqual({
			PATH: '/usr/bin',
			HOME: '/home/job',
			ANTHROPIC_API_KEY: 'sk-ant',
			HTTPS_PROXY: 'http://127.0.0.1:8888',
			NO_PROXY: 'localhost',
			GIT_AUTHOR_NAME: 'build',
		})
	})

	it('Spawns children with the sandbox env (secrets removed, overrides applied)', async () => {
		vi.stubEnv('DATABASE_URL', 'postgres://leak')
		vi.stubEnv('KEEP_ME', 'yes')

		const result = await exec('sh', ['-c', 'echo "${DATABASE_URL:-unset} $KEEP_ME $EXTRA"'], {
			cwd: process.cwd(),
			env: { EXTRA: 'x' },
		})

		expect(result.code).toBe(0)
		expect(result.stdout.trim()).toBe('unset yes x')
		vi.unstubAllEnvs()
	})
})

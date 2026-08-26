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
			// git hooks (husky) are always off inside the job
			GIT_CONFIG_COUNT: '1',
			GIT_CONFIG_KEY_0: 'core.hooksPath',
			GIT_CONFIG_VALUE_0: '/dev/null',
			HUSKY: '0',
		})
	})

	it('Disables repo git hooks for every git command the job runs', async () => {
		const dir = await (await import('node:fs/promises')).mkdtemp('/tmp/mf-hooks-')
		await exec('git', ['init', '-q'], { cwd: dir })
		await exec('git', ['config', 'core.hooksPath', '.hooks'], { cwd: dir })
		const shown = await exec('git', ['config', 'core.hooksPath'], { cwd: dir })
		expect(shown.stdout.trim()).toBe('/dev/null')
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

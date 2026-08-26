import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
	exec,
	execOrThrow,
	launch,
	redactUrlCredentials,
	sandboxEnv,
	sandboxUser,
	workerEnv,
} from '#job/exec.ts'

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
			APPRUNNER_CONNECTION_ARN: 'arn:apprunner:connection',
			APPRUNNER_INSTANCE_ROLE_ARN: 'arn:iam:role',
			GITHUB_TOKEN: 'ghp_x',
			JOB_TOKEN: 'job-report-token',
			JOB_ID: 'job-1',
			GITHUB_ORG: 'mjukvaruhuset',
			API_URL: 'https://api.example',
		})

		expect(env).toEqual({
			PATH: '/usr/bin',
			HOME: '/home/job',
			ANTHROPIC_API_KEY: 'sk-ant',
			HTTPS_PROXY: 'http://127.0.0.1:8888',
			NO_PROXY: 'localhost',
			GIT_AUTHOR_NAME: 'build',
			JOB_ID: 'job-1',
			GITHUB_ORG: 'mjukvaruhuset',
			API_URL: 'https://api.example',
			// git hooks (husky) are always off inside the job; the repo is shared between two uids
			GIT_CONFIG_COUNT: '3',
			GIT_CONFIG_KEY_0: 'core.hooksPath',
			GIT_CONFIG_VALUE_0: '/dev/null',
			GIT_CONFIG_KEY_1: 'safe.directory',
			GIT_CONFIG_VALUE_1: '*',
			GIT_CONFIG_KEY_2: 'core.sharedRepository',
			GIT_CONFIG_VALUE_2: 'group',
			HUSKY: '0',
		})
	})

	it('sandboxEnv strips every AWS_* and ECS_* key (task-role credential endpoint included)', () => {
		// Everything the ECS agent / AWS SDKs read to find or hold credentials — none may reach a
		// worker, whatever the sidecar's NO_PROXY says about 169.254.170.2
		const cloud = {
			AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/uuid',
			AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://169.254.170.2/v2/credentials/uuid',
			AWS_CONTAINER_AUTHORIZATION_TOKEN: 'tok',
			AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: '/run/token',
			AWS_ACCESS_KEY_ID: 'AKIA',
			AWS_SECRET_ACCESS_KEY: 'secret',
			AWS_SESSION_TOKEN: 'session',
			AWS_PROFILE: 'default',
			AWS_ROLE_ARN: 'arn:aws:iam::1:role/x',
			AWS_WEB_IDENTITY_TOKEN_FILE: '/run/web',
			AWS_REGION: 'eu-north-1',
			AWS_DEFAULT_REGION: 'eu-north-1',
			AWS_EXECUTION_ENV: 'AWS_ECS_FARGATE',
			AWS_: '',
			ECS_CONTAINER_METADATA_URI: 'http://169.254.170.2/v3',
			ECS_CONTAINER_METADATA_URI_V4: 'http://169.254.170.2/v4',
			ECS_AGENT_URI: 'http://169.254.170.2/api',
			ECS_: '',
		}
		const env = sandboxEnv({ ...cloud, PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk' })
		expect(Object.keys(env).filter(key => /^(AWS|ECS)_/.test(key))).toEqual([])
		expect(Object.keys(env).filter(key => key in cloud)).toEqual([])
		expect(env).toMatchObject({ PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk' })
		// Not a prefix match on "AWS"/"ECS" without the underscore
		expect(sandboxEnv({ AWSOME: '1', ECSTATIC: '1' })).toMatchObject({ AWSOME: '1', ECSTATIC: '1' })
	})

	it('Redacts URL credentials from the error of a failed command', async () => {
		// Arrange
		const url = 'https://x-access-token:ghp_secret@github.com/org/repo.git'

		// Act
		const error = await execOrThrow('git', ['ls-remote', url], { cwd: '/tmp' }).then(
			() => new Error('unexpectedly succeeded'),
			e => e as Error
		)

		// Assert
		expect(error.message).toContain('git ls-remote https://***@github.com/org/repo.git failed')
		expect(error.message).not.toContain('ghp_secret')
		expect(redactUrlCredentials('see https://u:p@h/x and ssh://k@h/y, not https://h/z')).toBe(
			'see https://***@h/x and ssh://***@h/y, not https://h/z'
		)
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

// MARK: Sandbox user (second uid for worker sessions)

describe('sandboxUser', () => {
	const own = String(process.getuid?.() ?? 0)

	it('Is unset without WORKER_UID, for a non-numeric value and for the job\'s own uid', () => {
		expect(sandboxUser({})).toBeUndefined()
		expect(sandboxUser({ WORKER_UID: '' })).toBeUndefined()
		expect(sandboxUser({ WORKER_UID: 'worker' })).toBeUndefined()
		expect(sandboxUser({ WORKER_UID: '0' })).toBeUndefined()
		expect(sandboxUser({ WORKER_UID: own })).toBeUndefined()
	})

	it('Reads the uid, an optional gid (default: the uid) and the home', () => {
		expect(sandboxUser({ WORKER_UID: '1001' })).toEqual({
			uid: 1001,
			gid: 1001,
			home: '/home/worker',
		})
		expect(sandboxUser({ WORKER_UID: '1001', WORKER_GID: '1002', WORKER_HOME: '/w' })).toEqual({
			uid: 1001,
			gid: 1002,
			home: '/w',
		})
	})

	it('workerEnv points HOME and the Claude config dir at the worker\'s own state', () => {
		expect(workerEnv({ uid: 1001, gid: 1001, home: '/home/worker' })).toEqual({
			HOME: '/home/worker',
			CLAUDE_CONFIG_DIR: '/home/worker/.claude',
		})
		expect(workerEnv(undefined)).toEqual({})
	})
})

describe('launch', () => {
	const user = { uid: 1001, gid: 1002, home: '/home/worker' }

	it('Spawns the command as is without a sandbox user', () => {
		expect(launch('npm', ['test'], { asWorker: true, user: undefined })).toEqual({
			command: 'npm',
			args: ['test'],
		})
	})

	it('Switches to the worker uid/gid with no capabilities and no_new_privs', () => {
		expect(launch('npm', ['test'], { asWorker: true, user })).toEqual({
			command: 'setpriv',
			args: [
				'--reuid=1001',
				'--regid=1002',
				'--init-groups',
				'--inh-caps=-all',
				'--ambient-caps=-all',
				'--no-new-privs',
				'--',
				'npm',
				'test',
			],
		})
	})

	it('Drops the job\'s ambient capabilities for its own children too', () => {
		expect(launch('git', ['status'], { user })).toEqual({
			command: 'setpriv',
			args: ['--inh-caps=-all', '--ambient-caps=-all', '--no-new-privs', '--', 'git', 'status'],
		})
	})

	it('exec goes through the launcher (job side: capability drop only, same uid)', async () => {
		// setpriv is util-linux; dropping nothing-you-have needs no privilege, so this runs anywhere
		const probe = await exec('setpriv', ['--version'], { cwd: process.cwd() })
		if (probe.code !== 0) return
		const umask = process.umask()
		vi.stubEnv('WORKER_UID', String((process.getuid?.() ?? 0) + 1))
		try {
			const result = await exec('sh', ['-c', 'id -u; grep NoNewPrivs /proc/self/status'], {
				cwd: process.cwd(),
			})
			expect(result.code).toBe(0)
			expect(result.stdout).toContain(`${process.getuid?.()}\n`)
			expect(result.stdout).toContain('NoNewPrivs:\t1')
		} finally {
			process.umask(umask)
			vi.unstubAllEnvs()
		}
	})
})

describe('shared work dir', () => {
	it('Writes group-writable files once a sandbox user is configured (umask 002)', async () => {
		const before = process.umask()
		vi.stubEnv('WORKER_UID', String((process.getuid?.() ?? 0) + 1))
		const dir = await mkdtemp(join(tmpdir(), 'mf-umask-'))
		try {
			await exec('true', [], { cwd: dir })
			await writeFile(join(dir, 'file'), 'x')
			const { mode } = await stat(join(dir, 'file'))
			expect(mode & 0o777).toBe(0o664)
			expect(await readFile(join(dir, 'file'), 'utf8')).toBe('x')
		} finally {
			process.umask(before)
			vi.unstubAllEnvs()
			await rm(dir, { recursive: true, force: true })
		}
	})
})

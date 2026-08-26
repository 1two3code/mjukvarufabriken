import { spawn } from 'node:child_process'
import { join } from 'node:path'

export type ExecResult = { code: number; stdout: string; stderr: string }

export type ExecOptions = {
	cwd: string
	signal?: AbortSignal
	env?: NodeJS.ProcessEnv
	/** Kill the process after this many ms (default 15 min) */
	timeoutMs?: number
	/**
	 * Run under the sandbox worker uid (`sandboxUser`): everything that executes model-driven or
	 * customer-repo code (agent sessions, the repo's lint/test/install scripts). Off = the job's
	 * own uid, for git and the file plumbing.
	 */
	asWorker?: boolean
}

/**
 * Environment keys that must never reach the model-driven sandbox (worker shell, repo scripts):
 * database credentials, secret ARNs, the ECS task-role credential endpoint and other AWS config,
 * the App Runner connection/instance-role ARNs (M5), the GitHub org token and the per-job api
 * reporting token (`JOB_TOKEN`, exchanged at start-up but still in the task environment — a
 * worker could otherwise forge job events).
 */
const secretEnvKey =
	/^(DATABASE_|AWS_|ECS_|APPRUNNER_|GITHUB_TOKEN$|JOB_TOKEN$|ARTIFACTS_BUCKET$)|_SECRET_ARN$/

/**
 * Git configuration for everything the job runs, via `GIT_CONFIG_*` so it applies to every git
 * process regardless of repo config:
 * - Hooks are off. The template ships husky hooks (conventional commit-msg, pre-push lint+test)
 *   meant for humans; a worker's `npm install` re-enables them via the `prepare` script and they
 *   then reject the orchestrator's merge commits (Fargate run 2026-08-26). The gates run lint +
 *   tests anyway. `HUSKY=0` covers hooks invoked some other way.
 * - `safe.directory=*` and `core.sharedRepository=group`: the job (uid `node`) and the worker
 *   sessions (uid `worker`, see `sandboxUser`) share `/work` through a common group, so git must
 *   accept a repo owned by the other uid and keep `.git` group-writable.
 */
export const noHooksEnv: NodeJS.ProcessEnv = {
	GIT_CONFIG_COUNT: '3',
	GIT_CONFIG_KEY_0: 'core.hooksPath',
	GIT_CONFIG_VALUE_0: '/dev/null',
	GIT_CONFIG_KEY_1: 'safe.directory',
	GIT_CONFIG_VALUE_1: '*',
	GIT_CONFIG_KEY_2: 'core.sharedRepository',
	GIT_CONFIG_VALUE_2: 'group',
	HUSKY: '0',
}

/** `process.env` minus credentials and cloud config — what child processes and agent sessions get */
export const sandboxEnv = (env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => ({
	...Object.fromEntries(Object.entries(env).filter(([key]) => !secretEnvKey.test(key))),
	...noHooksEnv,
})

// MARK: Sandbox user

/** The second unprivileged uid that runs worker sessions and the customer repo's scripts */
export type SandboxUser = { uid: number; gid: number; home: string }

const positiveInt = (value: string | undefined) => {
	const number = Number(value)
	return value && Number.isInteger(number) && number > 0 ? number : undefined
}

/**
 * Reads `WORKER_UID` / `WORKER_GID` (default: the uid) / `WORKER_HOME` (default `/home/worker`).
 * Unset, or equal to the job's own uid, means "no switch" — `npm run job:dev` and the tests run
 * everything as the current user. In the job image (`apps/job/Dockerfile`) the job starts as
 * root, `setpriv` drops it to `node` keeping only CAP_SETUID/CAP_SETGID as ambient
 * capabilities, and every worker launch (`launch`) uses `setpriv` again to switch to this uid
 * with an empty capability set and `no_new_privs` — a model-driven shell then cannot read the
 * job process's memory or `/proc/<pid>/environ`, and cannot get the capabilities back.
 */
export const sandboxUser = (env: NodeJS.ProcessEnv = process.env): SandboxUser | undefined => {
	const uid = positiveInt(env.WORKER_UID)
	if (!uid || uid === process.getuid?.()) return undefined
	return { uid, gid: positiveInt(env.WORKER_GID) ?? uid, home: env.WORKER_HOME || '/home/worker' }
}

/**
 * Files the job and the workers share (`/work`, group-owned with the setgid bit) must stay
 * group-writable, so the job process creates everything with `umask 002` while a sandbox user
 * is configured. Re-applied before every spawn (one syscall), so children inherit it too.
 */
const applySharedUmask = () => {
	if (sandboxUser()) process.umask(0o002)
}

/** Environment overrides for a process that runs as the sandbox user */
export const workerEnv = (user = sandboxUser()): NodeJS.ProcessEnv =>
	user ? { HOME: user.home, CLAUDE_CONFIG_DIR: join(user.home, '.claude') } : {}

export type Launch = { command: string; args: string[] }

/**
 * Command line to spawn `command` with the sandbox privileges: with a sandbox user configured,
 * every child goes through `setpriv` so the job's ambient capabilities never reach it; with
 * `asWorker` it also switches to the worker uid/gid (+ its supplementary groups, i.e. the shared
 * `work` group). Without a sandbox user the command is spawned as is.
 */
export const launch = (
	command: string,
	args: string[],
	{ asWorker = false, user = sandboxUser() }: { asWorker?: boolean; user?: SandboxUser } = {}
): Launch => {
	if (!user) return { command, args }
	const switchUser = asWorker
		? [`--reuid=${user.uid}`, `--regid=${user.gid}`, '--init-groups']
		: []
	return {
		command: 'setpriv',
		args: [
			...switchUser,
			'--inh-caps=-all',
			'--ambient-caps=-all',
			'--no-new-privs',
			'--',
			command,
			...args,
		],
	}
}

// MARK: Exec

/** Runs a command without a shell and captures its output; never throws on a non-zero exit */
export const exec = (
	command: string,
	args: string[],
	{ cwd, signal, env, timeoutMs = 15 * 60_000, asWorker = false }: ExecOptions
): Promise<ExecResult> =>
	new Promise((resolve, reject) => {
		applySharedUmask()
		const launched = launch(command, args, { asWorker })
		const child = spawn(launched.command, launched.args, {
			cwd,
			env: { ...sandboxEnv(), ...(asWorker ? workerEnv() : {}), ...env },
			stdio: ['ignore', 'pipe', 'pipe'],
			signal,
			timeout: timeoutMs,
			killSignal: 'SIGKILL',
		})
		let stdout = ''
		let stderr = ''
		child.stdout.on('data', chunk => (stdout += String(chunk)))
		child.stderr.on('data', chunk => (stderr += String(chunk)))
		child.on('error', reject)
		child.on('close', code => resolve({ code: code ?? -1, stdout, stderr }))
	})

/**
 * `user:password@` in any URL becomes `***@` — the error messages of `execOrThrow` end up in job
 * events, the job row and the logs, and `git push https://x-access-token:<token>@…` (M5) must
 * never leak the org token that way.
 */
export const redactUrlCredentials = (text: string) => text.replace(/\/\/[^\s/@]+@/g, '//***@')

/** Like `exec` but throws with the captured output on a non-zero exit (URL credentials redacted) */
export const execOrThrow = async (command: string, args: string[], options: ExecOptions) => {
	const result = await exec(command, args, options)
	if (result.code !== 0) {
		throw new Error(
			redactUrlCredentials(
				`${command} ${args.join(' ')} failed (${result.code}) in ${options.cwd}:\n${tail(result.stderr || result.stdout)}`
			)
		)
	}
	return result
}

export const git = (args: string[], options: ExecOptions) => execOrThrow('git', args, options)

/** Last `lines` lines of an output blob, for events and prompts */
export const tail = (text: string, lines = 60) => text.trim().split('\n').slice(-lines).join('\n')

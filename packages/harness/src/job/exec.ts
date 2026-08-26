import { spawn } from 'node:child_process'

export type ExecResult = { code: number; stdout: string; stderr: string }

export type ExecOptions = {
	cwd: string
	signal?: AbortSignal
	env?: NodeJS.ProcessEnv
	/** Kill the process after this many ms (default 15 min) */
	timeoutMs?: number
}

/**
 * Environment keys that must never reach the model-driven sandbox (worker shell, repo scripts):
 * database credentials, secret ARNs, the ECS task-role credential endpoint and other AWS config,
 * the App Runner connection/instance-role ARNs (M5) and the GitHub org token.
 */
const secretEnvKey = /^(DATABASE_|AWS_|ECS_|APPRUNNER_|GITHUB_TOKEN$|ARTIFACTS_BUCKET$)|_SECRET_ARN$/

/**
 * Git hooks are off for everything the job runs. The template ships husky hooks (conventional
 * commit-msg, pre-push lint+test) meant for humans; a worker's `npm install` re-enables them via
 * the `prepare` script and they then reject the orchestrator's merge commits (Fargate run
 * 2026-08-26). The gates run lint + tests anyway. `GIT_CONFIG_*` applies to every git process
 * regardless of repo config; `HUSKY=0` covers hooks invoked some other way.
 */
export const noHooksEnv: NodeJS.ProcessEnv = {
	GIT_CONFIG_COUNT: '1',
	GIT_CONFIG_KEY_0: 'core.hooksPath',
	GIT_CONFIG_VALUE_0: '/dev/null',
	HUSKY: '0',
}

/** `process.env` minus credentials and cloud config — what child processes and agent sessions get */
export const sandboxEnv = (env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => ({
	...Object.fromEntries(Object.entries(env).filter(([key]) => !secretEnvKey.test(key))),
	...noHooksEnv,
})

/** Runs a command without a shell and captures its output; never throws on a non-zero exit */
export const exec = (
	command: string,
	args: string[],
	{ cwd, signal, env, timeoutMs = 15 * 60_000 }: ExecOptions
): Promise<ExecResult> =>
	new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd,
			env: { ...sandboxEnv(), ...env },
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

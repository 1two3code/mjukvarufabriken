import { spawn } from 'node:child_process'
import { join } from 'node:path'

export type ExecResult = {
	code: number
	stdout: string
	stderr: string
	/**
	 * Either stream hit `maxOutputChars` and lost its beginning. A consumer that reads a stream
	 * from the START (a parser, a scanner) must treat this as a hard failure — the captured text
	 * is a tail, not the output. `execOrThrow`/`git` already do (see below); only tail-shaped
	 * consumers (`tail`, log lines) may ignore it.
	 */
	truncated: boolean
}

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
	/**
	 * Spawn the command as is, keeping the job's ambient capabilities (CAP_SETUID/SETGID/KILL).
	 * Only for the job's own trusted commands whose *children* must still be able to switch to the
	 * worker uid — `git fetch --upload-pack=setpriv --reuid=worker …` (`fetchTaskBranch`): wrapped
	 * in `setpriv --ambient-caps=-all` like everything else, the upload-pack child cannot setresuid
	 * (Fargate run 20baf983, 2026-08-27). Never combined with `asWorker`.
	 */
	keepCapabilities?: boolean
	/**
	 * Run the command in its own process group, killed whole on timeout/abort/exit (default: on
	 * for `asWorker` with a sandbox user — the worker's children must not outlive the command)
	 */
	processGroup?: boolean
	/** Cap on each captured stream, in characters (default `maxCapturedChars`) */
	maxOutputChars?: number
}

/**
 * Environment keys that must never reach the model-driven sandbox (worker shell, repo scripts):
 * database credentials, secret ARNs, the ECS task-role credential endpoint and other AWS config,
 * the ECS Express / CodeBuild / ECR delivery config (M5), the GitHub token / App private key
 * (GITHUB_APP_*), the per-job api reporting token (`JOB_TOKEN`, exchanged at start-up but still
 * in the task environment — a worker could otherwise forge job events), the artifacts-role ARN
 * (`ARTIFACTS_ROLE_ARN`, M3 hardening #1 — knowing it is harmless without the task-role
 * credentials this same strip already removes, but it names an internal role, not a tool input),
 * and the raw Anthropic key (`ANTHROPIC_API_KEY$`, exact — never `ANTHROPIC_BASE_URL`/
 * `ANTHROPIC_AUTH_TOKEN`, the harmless local-forward-proxy pointer + placeholder a session
 * legitimately needs, hardening audit 2026-08-30 finding A1: apps/job's own process no longer
 * holds the real key in its env at all — this strip is defense in depth for any future path that
 * might, not the primary control).
 */
const secretEnvKey =
	/^(DATABASE_|AWS_|ECS_|EXPRESS_|CODEBUILD_|ECR_|GITHUB_TOKEN$|GITHUB_APP_|JOB_TOKEN$|ARTIFACTS_BUCKET$|ARTIFACTS_ROLE_ARN$|ANTHROPIC_API_KEY$)|_SECRET_ARN$/

/**
 * Git's repository-location variables. Git exports these to hooks (and `git` sets them for its
 * own children), and every git command the harness runs is meant for the `cwd` repo it is given —
 * inherited, they silently redirect `git init`/`add`/`commit` to some OTHER repo. Seen for real
 * 2026-08-30: `npm test` under a husky pre-push hook ran the offline e2e, whose seed and
 * fake-worker commits landed on the developer's branch and were pushed to main (8b0bbe9).
 */
const gitRepoEnvKey =
	/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|PREFIX|NAMESPACE|CEILING_DIRECTORIES)$/

/**
 * Git configuration for everything the job runs, via `GIT_CONFIG_*` so it applies to every git
 * process regardless of repo config:
 * - Hooks are off. The template ships husky hooks (conventional commit-msg, pre-push lint+test)
 *   meant for humans; a worker's `npm install` re-enables them via the `prepare` script and they
 *   then reject the orchestrator's merge commits (Fargate run 2026-08-26). The gates run lint +
 *   tests anyway. `HUSKY=0` covers hooks invoked some other way.
 * - `safe.directory=*`: the job (uid `node`) and the worker sessions (uid `worker`, see
 *   `sandboxUser`) share `/work` through a common group, so git must accept a repo whose files
 *   the other uid owns. Nothing here makes `.git` group-writable: the main repo's `.git` is the
 *   job's alone (`protectGitDir`), and a task clone belongs to the worker.
 */
export const noHooksEnv: NodeJS.ProcessEnv = {
	GIT_CONFIG_COUNT: '2',
	GIT_CONFIG_KEY_0: 'core.hooksPath',
	GIT_CONFIG_VALUE_0: '/dev/null',
	GIT_CONFIG_KEY_1: 'safe.directory',
	GIT_CONFIG_VALUE_1: '*',
	HUSKY: '0',
}

/**
 * Git identity for every commit made inside the job — the workers' own commits and the harness's
 * auto-commits alike. Env, not repo config: a task clone starts without config, and a worker whose
 * commits fail with "please tell me who you are" ends its session with no commits at all
 * (Fargate run 7e60423e, 2026-08-27: 156 turns, empty branch). Overridable by the caller's env.
 */
export const gitIdentityEnv: NodeJS.ProcessEnv = {
	GIT_AUTHOR_NAME: 'Mjukvaruhuset build',
	GIT_AUTHOR_EMAIL: 'build@mjukvaruhuset.se',
	GIT_COMMITTER_NAME: 'Mjukvaruhuset build',
	GIT_COMMITTER_EMAIL: 'build@mjukvaruhuset.se',
}

/**
 * `process.env` minus credentials, cloud config and git's repository-location variables — what
 * child processes and agent sessions get
 */
export const sandboxEnv = (env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => ({
	...gitIdentityEnv,
	...Object.fromEntries(
		Object.entries(env).filter(([key]) => !secretEnvKey.test(key) && !gitRepoEnvKey.test(key))
	),
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
 * capabilities (plus CAP_KILL, so the job can still signal the worker uid's processes: spawn
 * timeouts, the budget/kill-switch abort, the Agent SDK's close sequence), and every worker
 * launch (`launch`) uses `setpriv` again to switch to this uid with an empty capability set and
 * `no_new_privs` — a model-driven shell then cannot read the job process's memory or
 * `/proc/<pid>/environ`, and cannot get the capabilities back.
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

/** A `Launch` as one shell command line (for git's `--upload-pack`); the parts carry no quoting */
export const launchCommandLine = ({ command, args }: Launch) => [command, ...args].join(' ')

/**
 * Command line to spawn `command` with the sandbox privileges: with a sandbox user configured,
 * every child goes through `setpriv` so the job's ambient capabilities never reach it; with
 * `asWorker` it also switches to the worker uid/gid (+ its supplementary groups, i.e. the shared
 * `work` group). Without a sandbox user the command is spawned as is.
 */
export const launch = (
	command: string,
	args: string[],
	{
		asWorker = false,
		keepCapabilities = false,
		user = sandboxUser(),
	}: { asWorker?: boolean; keepCapabilities?: boolean; user?: SandboxUser } = {}
): Launch => {
	if (!user) return { command, args }
	if (keepCapabilities) {
		if (asWorker) throw new Error('launch: keepCapabilities cannot be combined with asWorker')
		return { command, args }
	}
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

// MARK: Process groups

/**
 * Kills a whole process group (`SIGKILL`), tolerating a group that is already gone. Worker
 * processes run in their own group (`exec` with `asWorker`, `createWorkerSpawner`), so a timeout,
 * an abort or the end of a session takes every child the model's shell left behind (`npm run dev
 * &`, a stuck vitest) with it — except a process that started its own session (`setsid`); those
 * are swept by uid at points where no worker runs. Needs CAP_KILL when the group is another uid's.
 */
export const killProcessGroup = (pid: number | undefined) => {
	if (!pid) return false
	try {
		process.kill(-pid, 'SIGKILL')
		return true
	} catch {
		return false
	}
}

const isKillError = (error: unknown) =>
	typeof error === 'object' && error !== null && (error as { syscall?: string }).syscall === 'kill'

// MARK: Capture

/**
 * Cap on each captured stream. `spawn` has no `maxBuffer` (that is `execFile`), so before this
 * the capture grew without limit for the whole 15-minute timeout: model-written test code that
 * loops on `console.log` reached V8's ~512 MB single-string limit, and the `RangeError` thrown
 * inside a `'data'` listener — long after the promise executor returned — could not be caught or
 * rejected, so it killed the container as an `uncaughtException` (audit ORC-04).
 *
 * The value has a FLOOR, not just a ceiling: a capped stream is a tail, and every consumer that
 * parses a stream from the start would otherwise read a prefix that was silently dropped. The
 * largest such consumer is the delivery secret scan, which deliberately reads whole git blobs up
 * to its own 100 MiB `maxScannedBytes` window and fails closed only ABOVE it — a 128 MiB cap
 * keeps that entire window intact, so nothing the scan is willing to scan can arrive truncated.
 * (Belt and braces: `execOrThrow`/`git` refuse a truncated result outright.) Still far below
 * V8's string limit, and far above every other consumer — `npm ls --all --json --long` on a full
 * template tree is a few MB.
 */
export const maxCapturedChars = 128 * 1024 * 1024

/** Marks output that lost its beginning, so a truncated blob can never look complete */
export const truncationNotice = '[output truncated: earlier bytes dropped]\n'

/**
 * Rolling tail of a child stream: keeps at most `max` characters, dropping the oldest. Whole
 * leading chunks are dropped as they fall out of the window — never a re-join or a slice per
 * chunk — so the retained text stays under `max` plus one chunk and the cost is amortised O(1).
 * The final slice to exactly `max` happens once, in `value()`.
 */
const capture = (max: number) => {
	const chunks: string[] = []
	let length = 0
	let dropped = false
	return {
		push(chunk: string) {
			chunks.push(chunk)
			length += chunk.length
			while (chunks.length > 1 && length - chunks[0]!.length >= max) {
				length -= chunks.shift()!.length
				dropped = true
			}
		},
		value() {
			const text = chunks.join('')
			if (text.length > max) dropped = true
			return dropped ? truncationNotice + text.slice(-max) : text
		},
		/** Only meaningful after `value()`, which settles the final slice */
		get truncated() {
			return dropped
		},
	}
}

// MARK: Exec

/**
 * Runs a command without a shell and captures its output; never throws on a non-zero exit. A
 * timeout or an abort kills the process (its whole group with a sandbox user) — the result then
 * has a negative code — and a refused kill (no CAP_KILL) resolves with the error in `stderr`
 * instead of rejecting, so a gate never turns into an exception. Each stream is captured up to
 * `maxOutputChars` (see `maxCapturedChars`); beyond that the oldest output is dropped and the
 * result carries `truncationNotice`, so no consumer can mistake a truncated blob for a whole one.
 */
export const exec = (
	command: string,
	args: string[],
	{
		cwd,
		signal,
		env,
		timeoutMs = 15 * 60_000,
		asWorker = false,
		keepCapabilities = false,
		processGroup = asWorker && sandboxUser() !== undefined,
		maxOutputChars = maxCapturedChars,
	}: ExecOptions
): Promise<ExecResult> =>
	new Promise((resolve, reject) => {
		applySharedUmask()
		const launched = launch(command, args, { asWorker, keepCapabilities })
		const grouped = processGroup
		const child = spawn(launched.command, launched.args, {
			cwd,
			env: { ...sandboxEnv(), ...(asWorker ? workerEnv() : {}), ...env },
			stdio: ['ignore', 'pipe', 'pipe'],
			signal,
			timeout: timeoutMs,
			killSignal: 'SIGKILL',
			detached: grouped,
		})
		const killGroup = () => grouped && killProcessGroup(child.pid)
		const timer = setTimeout(killGroup, timeoutMs)
		signal?.addEventListener('abort', killGroup, { once: true })
		const stdout = capture(maxOutputChars)
		const stderr = capture(maxOutputChars)
		child.stdout.on('data', chunk => stdout.push(String(chunk)))
		child.stderr.on('data', chunk => stderr.push(String(chunk)))
		child.on('error', error => {
			if (!isKillError(error)) return reject(error)
			// kill(2) refused (EPERM): the process lives on, but the caller gets a result
			const out = stdout.value()
			const err = stderr.value()
			resolve({
				code: -1,
				stdout: out,
				stderr: `${err}\n${error.message}`.trim(),
				truncated: stdout.truncated || stderr.truncated,
			})
		})
		child.on('close', code => {
			clearTimeout(timer)
			signal?.removeEventListener('abort', killGroup)
			killGroup()
			const out = stdout.value()
			const err = stderr.value()
			resolve({
				code: code ?? -1,
				stdout: out,
				stderr: err,
				truncated: stdout.truncated || stderr.truncated,
			})
		})
	})

/**
 * `user:password@` in any URL becomes `***@` — the error messages of `execOrThrow` end up in job
 * events, the job row and the logs, and `git push https://x-access-token:<token>@…` (M5) must
 * never leak the org token that way.
 */
export const redactUrlCredentials = (text: string) => text.replace(/\/\/[^\s/@]+@/g, '//***@')

/**
 * Like `exec` but throws with the captured output on a non-zero exit (URL credentials redacted),
 * and — crucially — on a TRUNCATED capture even when the command succeeded.
 *
 * `execOrThrow` is the plumbing form, used for `git` and nothing else: every one of its callers
 * parses the output from the start (`ls-files`, `rev-list --objects`, `cat-file blob`,
 * `rev-parse`), so a silently dropped prefix is a wrong answer, not a shorter one. The delivery
 * secret scan is the case that makes this load-bearing: it reads whole history blobs through
 * `git` and reports `ok: true` when it finds nothing, so a truncated blob would be a green scan
 * over bytes nobody read. Failing here turns that into an aborted delivery instead. Commands
 * whose output is only ever tailed (gates, worker sessions) use plain `exec` and are unaffected.
 */
export const execOrThrow = async (command: string, args: string[], options: ExecOptions) => {
	const result = await exec(command, args, options)
	if (result.truncated) {
		throw new Error(
			redactUrlCredentials(
				`${command} ${args.join(' ')} produced more output than the ${options.maxOutputChars ?? maxCapturedChars} character capture cap in ${options.cwd} — refusing to use a truncated result`
			)
		)
	}
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

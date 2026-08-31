import { createAppAuth } from '@octokit/auth-app'
import { Octokit } from '@octokit/rest'

import { exec, redactUrlCredentials, tail } from '#job/exec.ts'

import type { CreatedRepo, GitHubClient } from './types.ts'

export const defaultGitHubOrg = 'mjukvaruhuset'

/** Env var name the inline credential helper below reads the token from — never git's argv */
const pushTokenEnvVar = 'MF_GIT_PUSH_TOKEN'

/**
 * Builds the `git push` argv + env for an authenticated push WITHOUT putting the token in argv
 * (hardening audit 2026-08-30, finding A3): `/proc/<pid>/cmdline` is world-readable with no
 * `hidepid`, so embedding the token in the push URL — an argv element — let any same-uid process
 * (e.g. a worker Bash command backgrounded with `nohup … &` that outlives its session) read the
 * org-wide GitHub App installation token. `git -c credential.helper=<inline shell function>` puts
 * only a *reference* to the env var in argv; the token itself exists solely in the child
 * process's environment, read by the `sh -c` git spawns internally when it needs credentials.
 */
export const buildPushInvocation = (cloneUrl: string, branch: string, token: string) => ({
	args: [
		'-c',
		`credential.helper=!f() { printf 'username=x-access-token\\npassword=%s\\n' "$${pushTokenEnvVar}"; }; f`,
		'push',
		'--force',
		cloneUrl,
		`${branch}:${branch}`,
	],
	env: { [pushTokenEnvVar]: token },
})

/**
 * `git push` of one branch over HTTPS. The error on a failed push is built from the plain
 * `cloneUrl` and a redacted stderr tail (never from the arguments), because that message becomes
 * a job event, the job's `reason` and a log line the customer can read.
 */
export const pushBranch = async (
	repoDir: string,
	cloneUrl: string,
	branch: string,
	token: string
) => {
	const { args, env } = buildPushInvocation(cloneUrl, branch, token)
	const result = await exec('git', args, { cwd: repoDir, timeoutMs: 10 * 60_000, env })
	if (result.code !== 0) {
		throw new Error(
			`git push ${branch} → ${cloneUrl} failed (${result.code}):\n${redactUrlCredentials(tail(result.stderr || result.stdout))}`
		)
	}
}

/** A GitHub App's identity: signs a JWT (`privateKey`) to mint short-lived installation tokens */
export type GitHubAppAuth = { appId: string; privateKey: string; installationId: number }

/**
 * Octokit authenticated as a GitHub App installation. `@octokit/auth-app` mints (and refreshes)
 * a 1-hour installation token for every REST call from the App's private key — no long-lived PAT.
 * The git push runs an external process, so its token is minted explicitly per push.
 */
export const createOctokitGitHubClient = (auth: GitHubAppAuth): GitHubClient => {
	const octokit = new Octokit({ authStrategy: createAppAuth, auth, userAgent: 'mf-harness/0.1' })
	const installationToken = async () =>
		((await octokit.auth({ type: 'installation' })) as { token: string }).token
	return {
		createRepo: async ({ org, name, description }) => {
			const { data } = await octokit.rest.repos.createInOrg({
				org,
				name,
				description,
				private: true,
				has_wiki: false,
				has_projects: false,
				auto_init: false,
			})
			return { url: data.html_url, cloneUrl: data.clone_url }
		},
		push: async ({ repoDir, cloneUrl, branch }) =>
			pushBranch(repoDir, cloneUrl, branch, await installationToken()),
		addCollaborator: async ({ org, name, login, permission }) => {
			await octokit.rest.repos.addCollaborator({
				owner: org,
				repo: name,
				username: login,
				permission,
			})
		},
	}
}

// MARK: Fakes

export type FakeGitHub = GitHubClient & {
	repos: { org: string; name: string; description: string }[]
	pushes: { repoDir: string; cloneUrl: string; branch: string }[]
	collaborators: { org: string; name: string; login: string; permission: string }[]
}

/** In-memory GitHub: records every call; `failOn` makes one method reject */
export const createFakeGitHubClient = (failOn?: keyof GitHubClient): FakeGitHub => {
	const fake: FakeGitHub = {
		repos: [],
		pushes: [],
		collaborators: [],
		createRepo: async input => {
			if (failOn === 'createRepo') throw new Error('fake: createRepo failed')
			fake.repos.push(input)
			return fakeRepo(input.org, input.name)
		},
		push: async input => {
			if (failOn === 'push') throw new Error('fake: push failed')
			fake.pushes.push(input)
		},
		addCollaborator: async input => {
			if (failOn === 'addCollaborator') throw new Error('fake: addCollaborator failed')
			fake.collaborators.push(input)
		},
	}
	return fake
}

export const fakeRepo = (org: string, name: string): CreatedRepo => ({
	url: `https://github.com/${org}/${name}`,
	cloneUrl: `https://github.com/${org}/${name}.git`,
})

/** Logs what would be done and returns the URLs the real call would produce */
export const createDryRunGitHubClient = (log: (line: string) => void): GitHubClient => ({
	createRepo: async ({ org, name }) => {
		log(`[dry-run] github: create private repo ${org}/${name}`)
		return fakeRepo(org, name)
	},
	push: async ({ cloneUrl, branch }) => log(`[dry-run] github: push ${branch} → ${cloneUrl}`),
	addCollaborator: async ({ org, name, login, permission }) =>
		log(`[dry-run] github: add ${login} as ${permission} on ${org}/${name}`),
})

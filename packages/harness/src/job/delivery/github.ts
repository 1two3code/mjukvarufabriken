import { Octokit } from '@octokit/rest'

import { git } from '#job/exec.ts'

import type { CreatedRepo, GitHubClient } from './types.ts'

export const defaultGitHubOrg = 'mjukvaruhuset'

/** Push URL with the token as the `x-access-token` user — built per call, never logged or stored */
const authenticatedCloneUrl = (cloneUrl: string, token: string) => {
	const url = new URL(cloneUrl)
	url.username = 'x-access-token'
	url.password = token
	return url.toString()
}

/** `git push` of one branch over HTTPS; the token only lives in the argument list of this one process */
export const pushBranch = async (
	repoDir: string,
	cloneUrl: string,
	branch: string,
	token: string
) => {
	await git(['push', '--force', authenticatedCloneUrl(cloneUrl, token), `${branch}:${branch}`], {
		cwd: repoDir,
		timeoutMs: 10 * 60_000,
	})
}

/** Octokit against api.github.com with `GITHUB_TOKEN` (repo + admin:org scope on the org) */
export const createOctokitGitHubClient = (token: string): GitHubClient => {
	const octokit = new Octokit({ auth: token, userAgent: 'mf-harness/0.1' })
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
		push: ({ repoDir, cloneUrl, branch }) => pushBranch(repoDir, cloneUrl, branch, token),
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

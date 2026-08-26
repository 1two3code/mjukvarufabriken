import { exec, git, redactUrlCredentials, tail } from '@mf/harness'
import { Octokit } from '@octokit/rest'

/** An open issue carrying the resident label — the customer's way of queueing work */
export type ResidentIssue = {
	number: number
	title: string
	body: string
	/** Set when the resident already commented / labelled it (so it is not queued twice) */
	labels: string[]
}

export type PullRequest = { number: number; url: string }

/**
 * Everything the resident asks GitHub for, scoped to one repository. `clone`/`push` shell out
 * to git with the token in the URL of that one process (never in the environment the worker
 * sessions inherit); the rest is the REST API through Octokit.
 */
export type ResidentGitHub = {
	repository: string
	/** Open issues with `label`, oldest first */
	listIssues: (label: string) => Promise<ResidentIssue[]>
	addLabels: (issueNumber: number, labels: string[]) => Promise<void>
	removeLabel: (issueNumber: number, label: string) => Promise<void>
	comment: (issueNumber: number, body: string) => Promise<void>
	/** Fresh clone of the default branch into `dir` (which must not exist) */
	clone: (dir: string, signal?: AbortSignal) => Promise<{ defaultBranch: string }>
	/** Pushes the local `branch` of `repoDir` (force, the branch is the resident's own) */
	push: (repoDir: string, branch: string) => Promise<void>
	createPullRequest: (input: {
		head: string
		base: string
		title: string
		body: string
	}) => Promise<PullRequest>
}

export type OctokitGitHubOptions = {
	/** `owner/name` */
	repository: string
	token: string
	log?: (line: string) => void
}

const splitRepository = (repository: string) => {
	const [owner, repo] = repository.split('/')
	if (!owner || !repo) throw new Error(`GITHUB_REPOSITORY must be owner/name, got "${repository}"`)
	return { owner, repo }
}

const cloneUrlOf = (repository: string) => `https://github.com/${repository}.git`

const authenticatedUrl = (url: string, token: string) => {
	const parsed = new URL(url)
	parsed.username = 'x-access-token'
	parsed.password = token
	return parsed.toString()
}

export const createOctokitResidentGitHub = ({
	repository,
	token,
}: OctokitGitHubOptions): ResidentGitHub => {
	const { owner, repo } = splitRepository(repository)
	const octokit = new Octokit({ auth: token, userAgent: 'mf-resident/0.1' })
	const cloneUrl = cloneUrlOf(repository)

	return {
		repository,
		listIssues: async label => {
			const issues = await octokit.paginate(octokit.rest.issues.listForRepo, {
				owner,
				repo,
				labels: label,
				state: 'open',
				sort: 'created',
				direction: 'asc',
				per_page: 100,
			})
			return issues
				.filter(issue => !issue.pull_request)
				.map(issue => ({
					number: issue.number,
					title: issue.title,
					body: issue.body ?? '',
					labels: issue.labels.map(item => (typeof item === 'string' ? item : (item.name ?? ''))),
				}))
		},
		addLabels: async (issueNumber, labels) => {
			await octokit.rest.issues.addLabels({ owner, repo, issue_number: issueNumber, labels })
		},
		removeLabel: async (issueNumber, label) => {
			await octokit.rest.issues
				.removeLabel({ owner, repo, issue_number: issueNumber, name: label })
				.catch(error => {
					if ((error as { status?: number }).status !== 404) throw error
				})
		},
		comment: async (issueNumber, body) => {
			await octokit.rest.issues.createComment({ owner, repo, issue_number: issueNumber, body })
		},
		clone: async (dir, signal) => {
			const result = await exec(
				'git',
				['clone', '--quiet', authenticatedUrl(cloneUrl, token), dir],
				{
					cwd: '/',
					signal,
					timeoutMs: 10 * 60_000,
				}
			)
			if (result.code !== 0) {
				throw new Error(
					`git clone ${cloneUrl} failed (${result.code}):\n${redactUrlCredentials(tail(result.stderr))}`
				)
			}
			// The pushed remote must never keep the token: point origin at the plain URL again
			await git(['remote', 'set-url', 'origin', cloneUrl], { cwd: dir, signal })
			const head = await git(['symbolic-ref', '--short', 'HEAD'], { cwd: dir, signal })
			return { defaultBranch: head.stdout.trim() || 'main' }
		},
		push: async (repoDir, branch) => {
			const result = await exec(
				'git',
				['push', '--force', authenticatedUrl(cloneUrl, token), `${branch}:${branch}`],
				{ cwd: repoDir, timeoutMs: 10 * 60_000 }
			)
			if (result.code !== 0) {
				throw new Error(
					`git push ${branch} → ${cloneUrl} failed (${result.code}):\n${redactUrlCredentials(tail(result.stderr || result.stdout))}`
				)
			}
		},
		createPullRequest: async ({ head, base, title, body }) => {
			const { data } = await octokit.rest.pulls.create({ owner, repo, head, base, title, body })
			return { number: data.number, url: data.html_url }
		},
	}
}

// MARK: Fake

export type FakeGitHub = ResidentGitHub & {
	issues: ResidentIssue[]
	comments: { issueNumber: number; body: string }[]
	pushes: { repoDir: string; branch: string }[]
	pullRequests: { head: string; base: string; title: string; body: string }[]
	failOn?: keyof ResidentGitHub
}

/** In-memory GitHub: issues are seeded by the test, every call is recorded */
export const createFakeGitHub = (
	issues: ResidentIssue[] = [],
	repository = 'acme/shop'
): FakeGitHub => {
	const fake: FakeGitHub = {
		repository,
		issues,
		comments: [],
		pushes: [],
		pullRequests: [],
		listIssues: async label => {
			if (fake.failOn === 'listIssues') throw new Error('fake: listIssues failed')
			return fake.issues.filter(issue => issue.labels.includes(label))
		},
		addLabels: async (issueNumber, labels) => {
			const issue = fake.issues.find(item => item.number === issueNumber)
			if (issue) issue.labels = [...new Set([...issue.labels, ...labels])]
		},
		removeLabel: async (issueNumber, label) => {
			const issue = fake.issues.find(item => item.number === issueNumber)
			if (issue) issue.labels = issue.labels.filter(item => item !== label)
		},
		comment: async (issueNumber, body) => {
			fake.comments.push({ issueNumber, body })
		},
		clone: async () => {
			if (fake.failOn === 'clone') throw new Error('fake: clone failed')
			return { defaultBranch: 'main' }
		},
		push: async (repoDir, branch) => {
			if (fake.failOn === 'push') throw new Error('fake: push failed')
			fake.pushes.push({ repoDir, branch })
		},
		createPullRequest: async input => {
			if (fake.failOn === 'createPullRequest') throw new Error('fake: createPullRequest failed')
			fake.pullRequests.push(input)
			const number = fake.pullRequests.length
			return { number, url: `https://github.com/${repository}/pull/${number}` }
		},
	}
	return fake
}

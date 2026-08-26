import fp from 'fastify-plugin'

import type { FastifyPluginAsync } from 'fastify'

/** What the api needs from a GitHub account to sign the user in (M6) */
export type GithubProfile = {
	/** Numeric account id as a string — stable across renames */
	id: string
	login: string
	name?: string
	/** The account's primary verified email — undefined when GitHub has none verified */
	email?: string
}

/**
 * The GitHub OAuth web flow behind an interface, so tests and local dev run against a fake.
 * `authorizeUrl` sends the browser to GitHub; `fetchProfile` exchanges the returned code and
 * reads `/user` + `/user/emails` with the resulting token (the token is never stored).
 */
export type GitHubOAuthClient = {
	/** False when no OAuth App is configured (`secrets.githubOauth`) — the routes answer 404 */
	configured: boolean
	authorizeUrl: (input: { state: string; redirectUri: string }) => string
	fetchProfile: (input: { code: string; redirectUri: string }) => Promise<GithubProfile>
}

declare module 'fastify' {
	interface FastifyInstance {
		githubOauth: GitHubOAuthClient
	}
}

export const githubAuthorizeUrl = 'https://github.com/login/oauth/authorize'
export const githubTokenUrl = 'https://github.com/login/oauth/access_token'
export const githubApiUrl = 'https://api.github.com'
/** Grants `/user/emails` (read of the profile is implied); nothing on repos */
export const githubScope = 'user:email'
/** A stalled GitHub endpoint must not hold the callback request open until the ALB gives up */
export const githubRequestTimeoutMs = 10_000

type TokenResponse = { access_token?: string; error?: string; error_description?: string }
type UserResponse = { id: number; login: string; name: string | null }
type EmailEntry = { email: string; primary: boolean; verified: boolean }

export class GithubOAuthError extends Error {
	constructor(step: string, detail: string) {
		super(`GitHub OAuth ${step} failed: ${detail}`)
	}
}

/** `fetch` with the timeout; an abort becomes a GithubOAuthError for the step */
const fetchWithTimeout = async (step: string, url: string, init: RequestInit) => {
	try {
		return await fetch(url, { ...init, signal: AbortSignal.timeout(githubRequestTimeoutMs) })
	} catch (error) {
		const name = (error as Error).name
		if (name === 'TimeoutError' || name === 'AbortError') {
			throw new GithubOAuthError(step, `timeout after ${githubRequestTimeoutMs} ms`)
		}
		throw error
	}
}

/** GitHub's primary email when verified, else any verified one, else nothing */
export const pickVerifiedEmail = (emails: EmailEntry[]) => {
	const verified = emails.filter(entry => entry.verified && entry.email)
	return (verified.find(entry => entry.primary) ?? verified[0])?.email
}

export const unconfiguredClient: GitHubOAuthClient = {
	configured: false,
	authorizeUrl: () => {
		throw new GithubOAuthError('authorize', 'not configured')
	},
	fetchProfile: () => Promise.reject(new GithubOAuthError('exchange', 'not configured')),
}

export const createGithubOauthClient = (credentials: {
	clientId: string
	clientSecret: string
}): GitHubOAuthClient => {
	const api = async <T>(path: string, accessToken: string): Promise<T> => {
		const response = await fetchWithTimeout(path, `${githubApiUrl}${path}`, {
			headers: {
				accept: 'application/vnd.github+json',
				authorization: `Bearer ${accessToken}`,
				'user-agent': 'mjukvaruhuset-api',
				'x-github-api-version': '2022-11-28',
			},
		})
		if (!response.ok) throw new GithubOAuthError(path, `HTTP ${response.status}`)
		return (await response.json()) as T
	}

	const exchangeCode = async (code: string, redirectUri: string) => {
		const response = await fetchWithTimeout('exchange', githubTokenUrl, {
			method: 'POST',
			headers: { accept: 'application/json', 'content-type': 'application/json' },
			body: JSON.stringify({
				client_id: credentials.clientId,
				client_secret: credentials.clientSecret,
				code,
				redirect_uri: redirectUri,
			}),
		})
		if (!response.ok) throw new GithubOAuthError('exchange', `HTTP ${response.status}`)
		const body = (await response.json()) as TokenResponse
		if (!body.access_token) {
			throw new GithubOAuthError('exchange', body.error_description ?? body.error ?? 'no token')
		}
		return body.access_token
	}

	return {
		configured: true,
		authorizeUrl: ({ state, redirectUri }) => {
			const url = new URL(githubAuthorizeUrl)
			url.searchParams.set('client_id', credentials.clientId)
			url.searchParams.set('redirect_uri', redirectUri)
			url.searchParams.set('scope', githubScope)
			url.searchParams.set('state', state)
			return url.toString()
		},
		fetchProfile: async ({ code, redirectUri }) => {
			const accessToken = await exchangeCode(code, redirectUri)
			const [user, emails] = await Promise.all([
				api<UserResponse>('/user', accessToken),
				api<EmailEntry[]>('/user/emails', accessToken),
			])
			return {
				id: String(user.id),
				login: user.login,
				name: user.name ?? undefined,
				email: pickVerifiedEmail(emails),
			}
		},
	}
}

const plugin: FastifyPluginAsync = async app => {
	const { githubOauth } = app.secrets
	if (!githubOauth) {
		app.log.info('GitHub sign-in disabled: GITHUB_OAUTH_CLIENT_ID / client secret not set')
		app.decorate('githubOauth', unconfiguredClient)
		return
	}
	app.decorate('githubOauth', createGithubOauthClient(githubOauth))
}

export default fp(plugin, { name: '#internal/githubOauth', dependencies: ['#internal/secrets'] })

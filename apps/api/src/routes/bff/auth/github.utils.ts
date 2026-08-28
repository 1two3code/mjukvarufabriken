import { timingSafeEqual } from 'node:crypto'

/** Holds the OAuth `state` between the redirect to GitHub and the callback (httpOnly) */
export const stateCookieName = 'mf_github_state'
export const stateCookieMaxAgeSeconds = 10 * 60

/** Where GitHub sends the browser back — the portal page forwards to the api callback */
export const githubRedirectUri = (portalUrl: string) =>
	new URL('/auth/github/callback', portalUrl).toString()

/** Error codes the portal's `/auth/github/callback` page knows how to explain */
export const githubSignInErrors = ['state', 'expired', 'denied', 'email', 'failed'] as const
export type GithubSignInError = (typeof githubSignInErrors)[number]

export const githubErrorRedirect = (portalUrl: string, error: GithubSignInError) => {
	const url = new URL('/auth/github/callback', portalUrl)
	url.searchParams.set('error', error)
	return url.toString()
}

const cookieAttributes = (secure: boolean) =>
	['Path=/bff/auth/github', 'HttpOnly', 'SameSite=Lax', ...(secure ? ['Secure'] : [])].join('; ')

export const buildStateCookie = (state: string, secure: boolean) =>
	`${stateCookieName}=${state}; Max-Age=${stateCookieMaxAgeSeconds}; ${cookieAttributes(secure)}`

export const clearStateCookie = (secure: boolean) =>
	`${stateCookieName}=; Max-Age=0; ${cookieAttributes(secure)}`

/** The state cookie's value from a raw `Cookie` header, undefined when absent */
export const readStateCookie = (cookieHeader: string | undefined) => {
	for (const part of cookieHeader?.split(';') ?? []) {
		const [name, ...rest] = part.trim().split('=')
		if (name === stateCookieName) return rest.join('=') || undefined
	}
	return undefined
}

/** Constant-time comparison of the callback's `state` with the cookie */
export const isSameState = (expected: string | undefined, actual: string) => {
	if (!expected) return false
	// Byte lengths, not string lengths: timingSafeEqual throws on buffers of different size
	const [a, b] = [Buffer.from(expected), Buffer.from(actual)]
	return a.length === b.length && timingSafeEqual(a, b)
}

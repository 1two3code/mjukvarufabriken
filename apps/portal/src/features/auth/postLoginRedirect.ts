/**
 * Where to land after signing in. The magic-link flow crosses an email: the visitor asks for the
 * link on `/login?redirect=…` and comes back on `/auth/callback?token=…`, which carries no
 * redirect of its own — so the login page remembers the wanted path in this origin's storage and
 * the callback picks it up (same browser, which is the normal case; another browser lands on `/`).
 * The site's "save / order this quote" button relies on this to reach `/claim?…` after login.
 */
const storageKey = 'postLoginRedirect'

/** Only same-origin paths are honoured as post-login redirects */
export const safeRedirect = (value: string | null | undefined) =>
	value && value.startsWith('/') && !value.startsWith('//') ? value : '/'

/**
 * Remembers a safe redirect for the next sign-in — or, with none, forgets any earlier one, so a
 * plain `/login` visit never replays a stale `/claim?…token` from a previous hand-off.
 */
export const rememberPostLoginRedirect = (value: string | null) => {
	try {
		if (safeRedirect(value) === '/') localStorage.removeItem(storageKey)
		else localStorage.setItem(storageKey, value as string)
	} catch {
		// Storage unavailable (private mode, blocked): the visitor simply lands on the home page
	}
}

/** The remembered redirect, cleared on read so it is used once */
export const takePostLoginRedirect = (): string | null => {
	try {
		const value = localStorage.getItem(storageKey)
		localStorage.removeItem(storageKey)
		return value
	} catch {
		return null
	}
}

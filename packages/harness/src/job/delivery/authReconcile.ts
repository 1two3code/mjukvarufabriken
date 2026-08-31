import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Auth-allowlist reconciliation (hardening audit 2026-08-30, findings A1–A3): the delivered
 * template api 401s every `/bff` route that is not in its `publicUrls` set, and the delivered
 * preview has no working login — so a route the SPA calls that is not allowlisted is dead for
 * every visitor even though it exists. wiredSmoke's original 401-is-pass rule made exactly that
 * invisible (the un-fixed second half of the guestbook incident). This module parses the
 * delivered repo's own `publicUrls` declaration so the smoke checks can judge a 401 instead of
 * waving it through.
 */

// MARK: publicUrls extraction

/**
 * The literal entries of the `publicUrls` set/array a delivered auth plugin declares
 * (`const publicUrls = new Set(['/bff/auth/refresh'])`). Parsed with a regex, never evaluated —
 * the built repo is untrusted. Returns undefined when no declaration is found (the caller then
 * knows the allowlist is UNDISCOVERABLE, which is different from a discovered-empty one).
 */
export const parsePublicUrls = (source: string): string[] | undefined => {
	const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
	const match = stripped.match(/\bpublicUrls\b\s*(?::[^=]+)?=\s*(?:new\s+Set\s*\(\s*)?\[([\s\S]*?)\]/)
	if (!match) return undefined
	return [...new Set([...match[1]!.matchAll(/['"`]([^'"`]*)['"`]/g)].map(entry => entry[1]!))]
}

const readIfExists = async (path: string): Promise<string | undefined> => {
	try {
		return await readFile(path, 'utf8')
	} catch {
		return undefined
	}
}

/**
 * The delivered repo's `publicUrls` allowlist, from the first `src/plugins/auth.ts` found under
 * `apps/<app>/` or the repo root. Undefined when no auth plugin declares one — an app without
 * the template auth plugin has no allowlist to reconcile against.
 */
export const readPublicUrls = async (repoDir: string): Promise<string[] | undefined> => {
	const roots = [repoDir]
	try {
		const apps = (await readdir(join(repoDir, 'apps'), { withFileTypes: true }))
			.filter(entry => entry.isDirectory())
			.map(entry => join(repoDir, 'apps', entry.name))
		roots.push(...apps)
	} catch {
		// no apps/ dir
	}
	for (const root of roots) {
		const source = await readIfExists(join(root, 'src', 'plugins', 'auth.ts'))
		if (!source) continue
		const urls = parsePublicUrls(source)
		if (urls) return urls
	}
	return undefined
}

// MARK: Probe evaluation

/**
 * Template auth-bootstrap routes the template SPA is BUILT to receive a 401/501 from while
 * logged out (`/bff/session` → "show the login page", `/bff/auth/refresh` → 501 without an
 * IdP). These are part of the template contract, not the generated app's surface, so the smoke
 * checks probe them but never judge them.
 */
export const authBootstrapPaths = new Set([
	'/bff/auth/refresh',
	'/bff/session',
	// The same routes when the app mounts its api without the /bff prefix (base-relative probes)
	'/auth/refresh',
	'/session',
])

export type ProbeVerdict = {
	ok: boolean
	/** Why the probe failed (absent when ok, or when the path is an exempt bootstrap route) */
	reason?: string
}

/**
 * Judges one anonymous probe of a frontend-called route. The delivered preview's visitor holds
 * no token, so the anonymous response IS the customer experience:
 *   404 / unreachable → the route is not registered (the original guestbook wiring bug)
 *   401/403           → the visitor is locked out (the guestbook incident's un-fixed half) —
 *                       allowlisted-but-rejected and not-allowlisted get their own diagnosis
 *   5xx               → the route exists but is broken (dead database, missing env, …)
 *   2xx/3xx/400       → the route answers; 400 means "exists, wants a body" (fine for a smoke)
 * `publicUrls` is the delivered repo's own allowlist (undefined = undiscoverable).
 */
export const judgeAnonymousProbe = (
	path: string,
	status: number,
	publicUrls: string[] | undefined
): ProbeVerdict => {
	if (authBootstrapPaths.has(path)) return { ok: true }
	if (status === 0) return { ok: false, reason: `${path}: unreachable (no response)` }
	if (status === 404) return { ok: false, reason: `${path}: not registered (404)` }
	if (status === 401 || status === 403) {
		if (publicUrls?.includes(path)) {
			return {
				ok: false,
				reason:
					`${path}: ${status} although listed in publicUrls — the allowlist entry does not ` +
					`match the registered route (parametric pattern or typo?)`,
			}
		}
		return {
			ok: false,
			reason:
				`${path}: ${status} for an anonymous visitor and not in the api's publicUrls allowlist ` +
				`— the delivered preview has no login, so every visitor is locked out of this route ` +
				`(add it to publicUrls in plugins/auth.ts if it is meant to be public)`,
		}
	}
	if (status >= 500) return { ok: false, reason: `${path}: ${status} (route exists but is broken)` }
	return { ok: true }
}

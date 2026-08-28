import { randomBytes } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { generateAppSecrets } from './appSecrets.ts'

import type { PreviewAuth } from './types.ts'

/**
 * The delivered app's required-runtime-env manifest — the fix for family-hub #2 (delivered but
 * 503). The Express deploy used to inject only the *template's* auth contract, but a generated app
 * evolves its own required env (family-hub's `secrets` plugin required `AUTH_JWT_SECRET` +
 * `VAPID_*`) and threw on boot. Instead of hardcoding one contract, we DETECT the app's required
 * set from its own secrets/config plugin, GENERATE valid values for the shapes we own (JWT + web
 * push VAPID, and any self-issued signing secret), and inject the FULL set into both the boot
 * smoke-check and the live container. A required var we cannot synthesise (an external provider's
 * key) gets a clearly-flagged placeholder — so the app boots past its presence check — plus a TODO
 * surfaced to the operator, never a silent omission that crashloops the container.
 */

// MARK: Detection

/**
 * The `required` string-array literal a Fastify secrets/config plugin declares
 * (`const required = ['AUTH_AUDIENCE', …] as const`) — the names it throws on when absent. Parsed
 * with a regex (not evaluated): the built repo is untrusted, and the array is a plain literal.
 * Tolerates a type annotation (`: readonly string[]`) and picks out only env-var-shaped names.
 */
export const parseRequiredEnv = (source: string): string[] => {
	const match = source.match(/\brequired\b\s*(?::[^=]+)?=\s*\[([\s\S]*?)\]/)
	if (!match) return []
	const names = [...match[1]!.matchAll(/['"`]([A-Za-z_][A-Za-z0-9_]*)['"`]/g)].map(entry => entry[1]!)
	return [...new Set(names)]
}

/** Plugin files that may declare the required env, relative to an app's `src/` */
const pluginFiles = ['plugins/secrets.ts', 'plugins/config.ts', 'secrets.ts', 'config.ts']

/**
 * The union of every required env var declared across the built repo's apps — reads each app's
 * secrets/config plugin (`apps/<app>/src/plugins/secrets.ts`, …) and parses its `required` array.
 * A repo with no such plugin (a static site) yields `[]` and the caller injects only the
 * always-on app secrets.
 */
export const detectRequiredEnv = async (repoDir: string): Promise<string[]> => {
	const appsDir = join(repoDir, 'apps')
	let apps: string[]
	try {
		apps = (await readdir(appsDir, { withFileTypes: true }))
			.filter(entry => entry.isDirectory())
			.map(entry => entry.name)
	} catch {
		return []
	}
	const names = new Set<string>()
	for (const app of apps) {
		for (const file of pluginFiles) {
			try {
				const source = await readFile(join(appsDir, app, 'src', file), 'utf8')
				for (const name of parseRequiredEnv(source)) names.add(name)
			} catch {
				// plugin not present in this app — skip
			}
		}
	}
	return [...names]
}

// MARK: Generation

/**
 * Providers whose secret we must NOT synthesise: a random value satisfies the presence check and
 * boots the app, but it is not the real shared credential, so the app would misbehave live. These
 * get a flagged placeholder + a TODO instead — the operator supplies the true value.
 */
const externalProvider = /^(STRIPE|GITHUB|GH|ANTHROPIC|OPENAI|AWS|TWILIO|SENDGRID|MAILGUN|POSTMARK|SLACK|GOOGLE|GCP|META|SENTRY|MAPBOX|CLOUDFLARE|DATADOG)_/

/**
 * A required var whose value is a *self-issued* secret we can mint fresh and have it be fully valid
 * (a session / cookie / CSRF / token signing secret) — as opposed to a shared credential of some
 * external provider. Excludes the external providers above so e.g. `STRIPE_WEBHOOK_SECRET` is a
 * placeholder, not a random string that would silently fail signature checks.
 */
export const isSelfIssuedSecret = (name: string): boolean =>
	!externalProvider.test(name) && (/_SECRET$/.test(name) || name === 'SECRET_KEY')

/** Flagged placeholder value for a required var we cannot synthesise; recognisable in logs + env */
export const PLACEHOLDER_PREFIX = 'TODO_SET_BY_OPERATOR_'
export const placeholderValue = (name: string): string => `${PLACEHOLDER_PREFIX}${name}`
export const isPlaceholderValue = (value: string): boolean => value.startsWith(PLACEHOLDER_PREFIX)

// MARK: Manifest

export type EnvManifest = {
	/** The required var names declared by the built app's secrets/config plugin(s) */
	required: string[]
	/**
	 * The full runtime env to inject into both the boot smoke-check and the live container: the
	 * always-on generated app secrets (JWT + VAPID), the auth contract (from `previewAuth`), and a
	 * resolved value for every required var (generated, or a flagged placeholder).
	 */
	env: Record<string, string>
	/** Required vars we could not synthesise — a placeholder was injected; the operator must set real values */
	placeholders: string[]
	/** One operator-facing TODO line per placeholder (surfaced, never silently omitted) */
	todos: string[]
}

/**
 * Detects the built app's required runtime env and resolves a value for each: the app secrets and
 * auth contract we own, a fresh random value for a self-issued secret, or a flagged placeholder +
 * TODO for anything we cannot synthesise. The generated app secrets (JWT + VAPID) are injected
 * whether or not the app lists them in `required` — the app uses them at runtime beyond the boot
 * check, and a fresh value is always valid.
 */
export const buildEnvManifest = async (
	repoDir: string,
	previewAuth?: PreviewAuth
): Promise<EnvManifest> => {
	const required = await detectRequiredEnv(repoDir)
	const authContract: Record<string, string> = previewAuth
		? {
				AUTH_ISSUER: previewAuth.issuer,
				AUTH_JWKS_URL: previewAuth.jwksUrl,
				AUTH_AUDIENCE: previewAuth.audience,
			}
		: {}
	// App secrets first (always on), then the auth contract; both are valid generated values.
	const env: Record<string, string> = { ...generateAppSecrets(), ...authContract }
	const placeholders: string[] = []
	const todos: string[] = []
	for (const name of required) {
		if (name in env) continue // already covered by the app secrets or the auth contract
		if (isSelfIssuedSecret(name)) {
			env[name] = randomBytes(48).toString('base64url')
			continue
		}
		// Cannot synthesise a valid value — inject a flagged placeholder (so the required-presence
		// check passes and the app boots) and surface a TODO instead of a silent omission.
		env[name] = placeholderValue(name)
		placeholders.push(name)
		todos.push(
			`Required env var ${name}: no value could be generated — a placeholder was injected so the preview boots. Set the real value before the app is used for real.`
		)
	}
	return { required, env, placeholders, todos }
}

/** The manifest env as an ECS container `environment` list (`{ name, value }`), stable order. */
export const envList = (env: Record<string, string>): { name: string; value: string }[] =>
	Object.entries(env).map(([name, value]) => ({ name, value }))

import { randomBytes } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

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
	// Strip comments first so a `]` inside an inline comment (`'FOO', // see bar[0]`) cannot end the
	// non-greedy array capture early and truncate the list. Block comments then line comments.
	const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
	const match = stripped.match(/\brequired\b\s*(?::[^=]+)?=\s*\[([\s\S]*?)\]/)
	if (!match) return []
	const names = [...match[1]!.matchAll(/['"`]([A-Za-z_][A-Za-z0-9_]*)['"`]/g)].map(
		entry => entry[1]!
	)
	return [...new Set(names)]
}

/** Plugin files that may declare the required env, relative to a package's `src/` */
const pluginFiles = ['plugins/secrets.ts', 'plugins/config.ts', 'secrets.ts', 'config.ts']

/**
 * The `src/`-owning package roots whose secrets/config plugin may declare the required env: every
 * app under `apps/`, AND the repo root itself. The root is included so a generated app in a
 * non-`apps/` layout — a root-level `src/index.ts` that `serverEntryOf` now boots — has its env
 * detected too, aligning detection with the generalized boot target. A repo with neither yields no
 * roots' worth of plugins and the caller injects only the always-on app secrets.
 */
const packageRoots = async (repoDir: string): Promise<string[]> => {
	const roots = [repoDir]
	try {
		const apps = (await readdir(join(repoDir, 'apps'), { withFileTypes: true }))
			.filter(entry => entry.isDirectory())
			.map(entry => join(repoDir, 'apps', entry.name))
		roots.push(...apps)
	} catch {
		// no apps/ dir — root layout only
	}
	return roots
}

/**
 * The union of every required env var declared across the built repo — reads each package root's
 * secrets/config plugin (`apps/<app>/src/plugins/secrets.ts`, or a root-level `src/plugins/secrets.ts`
 * for a non-`apps/` layout, …) and parses its `required` array. A repo with no such plugin (a
 * static site) yields `[]` and the caller injects only the always-on app secrets.
 */
export const detectRequiredEnv = async (repoDir: string): Promise<string[]> => {
	const names = new Set<string>()
	for (const root of await packageRoots(repoDir)) {
		for (const file of pluginFiles) {
			try {
				const source = await readFile(join(root, 'src', file), 'utf8')
				for (const name of parseRequiredEnv(source)) names.add(name)
			} catch {
				// plugin not present here — skip
			}
		}
	}
	return [...names]
}

// MARK: Generation

/**
 * Providers whose secret we must NOT synthesise: a random value satisfies the presence check and
 * boots the app, but it is not the real shared credential, so the app would misbehave live. These
 * get a flagged placeholder + a TODO instead — the operator supplies the true value. Kept as a
 * defensive first cut even though the allowlist below is now authoritative (so e.g. a hypothetical
 * `GOOGLE_SIGNING_SECRET` — a provider credential that happens to contain a self-issued token — is
 * still treated as external, not minted).
 */
const externalProvider =
	/^(STRIPE|GITHUB|GH|ANTHROPIC|OPENAI|AWS|TWILIO|SENDGRID|MAILGUN|POSTMARK|SLACK|GOOGLE|GCP|META|SENTRY|MAPBOX|CLOUDFLARE|DATADOG)_/

/**
 * Underscore-delimited tokens that name a *self-issued* signing / session secret we can mint fresh
 * and have be fully valid: session / cookie / CSRF / JWT / signing / token secrets. Bare `SECRET_KEY`
 * (the canonical app signing key) is handled separately below.
 */
const selfIssuedToken = /(?:^|_)(SESSION|COOKIE|CSRF|JWT|SIGNING|TOKEN)(?:_|$)/

/**
 * A required var whose value is a *self-issued* secret we can mint fresh and have it be fully valid
 * (a session / cookie / CSRF / JWT / signing-token secret) — as opposed to a shared credential of
 * some external provider. The default is INVERTED: an unknown secret-shaped var (`*_SECRET` /
 * `*SECRET_KEY`) is NOT minted — it would get a silent random value that boots the app but fails
 * live (e.g. `PLAID_CLIENT_SECRET`, `STRIPE_WEBHOOK_SECRET`). Only a var matching the known
 * self-issued allowlist is minted; everything else falls through to a flagged placeholder + TODO.
 */
export const isSelfIssuedSecret = (name: string): boolean => {
	// Must be secret-shaped at all (`*_SECRET` or `*SECRET_KEY`) to be a candidate.
	if (!/(_SECRET|SECRET_KEY)$/.test(name)) return false
	// A recognised external provider's credential is never minted (defensive; allowlist is primary).
	if (externalProvider.test(name)) return false
	// Only a KNOWN self-issued name is minted — any other secret is an unknown shared credential.
	return name === 'SECRET_KEY' || selfIssuedToken.test(name)
}

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

// MARK: Database need (D1)

/** npm dependencies that mean "this app talks to a real Postgres/SQL database" */
const dbDependencies = ['pg', 'postgres', 'drizzle-orm', 'knex', '@prisma/client', 'typeorm', 'kysely']

export type DatabaseNeed = { needed: boolean; evidence: string[] }

/**
 * Whether the built app needs a real database at runtime (audit finding D1: env-manifest could
 * DETECT a required `DATABASE_URL` but nothing ever provisioned one — the app booted, served the
 * SPA, and 500'd on every read/write against a database that never existed). Three independent
 * signals, unioned: `DATABASE_URL` in the declared required env, a known DB client in any
 * package.json dependencies, or a `migrations/` directory. A false positive costs one unused
 * (empty) database; a false negative ships a dead app — so detection errs wide.
 */
export const detectDatabaseNeed = async (
	repoDir: string,
	required: string[]
): Promise<DatabaseNeed> => {
	const evidence: string[] = []
	if (required.includes('DATABASE_URL')) evidence.push('required env declares DATABASE_URL')
	for (const root of await packageRoots(repoDir)) {
		try {
			const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
				dependencies?: Record<string, string>
			}
			const found = dbDependencies.filter(name => pkg.dependencies?.[name])
			if (found.length) evidence.push(`${relative(repoDir, root) || '.'}/package.json depends on ${found.join(', ')}`)
		} catch {
			// no package.json here
		}
		try {
			await readdir(join(root, 'migrations'))
			evidence.push(`${relative(repoDir, root) || '.'}/migrations/ exists`)
		} catch {
			// no migrations dir
		}
	}
	return { needed: evidence.length > 0, evidence }
}

// MARK: Object-storage need (preview resources)

/**
 * npm dependencies that mean "this app puts files somewhere at runtime". The AWS SDK clients are
 * the direct signal; the upload middlewares are the indirect one — an app that accepts a file
 * upload has to put it somewhere, and on a preview that somewhere is S3, not the container's
 * ephemeral disk (which dies with every deployment).
 */
const storageDependencies = [
	'@aws-sdk/client-s3',
	'@aws-sdk/s3-request-presigner',
	'aws-sdk',
	'multer',
	'busboy',
	'@fastify/multipart',
	'formidable',
]

/** Env names that mean the app was written expecting a bucket */
const storageEnvNames = ['ATTACHMENTS_BUCKET', 'S3_BUCKET', 'AWS_S3_BUCKET', 'STORAGE_BUCKET', 'BUCKET_NAME']

export type StorageNeed = { needed: boolean; evidence: string[] }

/**
 * Whether the built app needs object storage at runtime. Same shape and same reasoning as
 * {@link detectDatabaseNeed}: a false positive costs one unused (empty) prefix and a role nobody
 * calls, a false negative ships an app whose every upload fails — or, worse, one that writes to
 * container-local disk and silently loses the files on the next deployment. So detection errs
 * wide, and delivery fails closed when the need is real but provisioning is unavailable.
 */
export const detectStorageNeed = async (
	repoDir: string,
	required: string[]
): Promise<StorageNeed> => {
	const evidence: string[] = []
	const declared = storageEnvNames.filter(name => required.includes(name))
	if (declared.length) evidence.push(`required env declares ${declared.join(', ')}`)
	for (const root of await packageRoots(repoDir)) {
		try {
			const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
				dependencies?: Record<string, string>
			}
			const found = storageDependencies.filter(name => pkg.dependencies?.[name])
			if (found.length) {
				evidence.push(
					`${relative(repoDir, root) || '.'}/package.json depends on ${found.join(', ')}`
				)
			}
		} catch {
			// no package.json here
		}
	}
	return { needed: evidence.length > 0, evidence }
}

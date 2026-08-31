import fp from 'fastify-plugin'
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'

import type { FastifyPluginAsync } from 'fastify'

export const emailTransports = ['ses', 'log'] as const
export type EmailTransport = (typeof emailTransports)[number]

declare module 'fastify' {
	interface FastifyInstance {
		secrets: {
			/** Deployment environment (`ENV`): `dev`, `live` or `local` */
			env: string
			/** Public URL of the SPA, used for CORS */
			appUrl: string
			/** Public URL of the customer portal — magic links point here (`PORTAL_URL`) */
			portalUrl: string
			/** `iss` claim of tokens minted by this api and expected on incoming tokens (`AUTH_ISSUER`) */
			authIssuer: string
			/** Expected `aud` claim (`AUTH_AUDIENCE`) */
			authAudience: string
			/**
			 * Ed25519 private key as a JSON JWK string for signing access tokens. From
			 * `AUTH_JWT_PRIVATE_KEY`, or resolved from Secrets Manager via
			 * `AUTH_JWT_PRIVATE_KEY_SECRET_ARN`. Undefined → the `authKeys` plugin generates an
			 * ephemeral key pair (dev convenience).
			 */
			authJwtPrivateKey?: string
			/** Emails that sign in as `admin` (`AUTH_ADMIN_EMAILS`, comma-separated, lower-cased) */
			authAdminEmails: string[]
			/** How outgoing email is delivered (`EMAIL_TRANSPORT`): `ses`, or `log` (default outside live) */
			emailTransport: EmailTransport
			/** Sender address for outgoing email (`AUTH_EMAIL_FROM`) */
			emailFrom: string
			/**
			 * Anthropic API key for the spec engine. From `ANTHROPIC_API_KEY`, or resolved from
			 * Secrets Manager via `ANTHROPIC_API_KEY_SECRET_ARN` at startup. Undefined when neither
			 * is set — the api still boots, the spec engine reports itself as unavailable.
			 */
			anthropicApiKey?: string
			/** Model id override for the spec engine (`SPEC_MODEL`) */
			specModel?: string
			/**
			 * Sentry (SaaS, free tier) DSN for error tracking. From `SENTRY_DSN`, or resolved from
			 * Secrets Manager via `SENTRY_DSN_SECRET_ARN`. Undefined when neither is set — the api
			 * still boots, the `sentry` plugin decorates an inert client instead of crashing (no
			 * Sentry project exists yet — TODO-EXTERNAL).
			 */
			sentryDsn?: string
			/**
			 * Resident installations (M8): installation id → bearer token the resident in the
			 * customer's account reports usage with. `RESIDENT_INSTALLATIONS` = `id:token,id:token`
			 * (or resolved from `RESIDENT_INSTALLATIONS_SECRET_ARN`); empty → no resident can report.
			 */
			residentInstallations: Record<string, string>
			/**
			 * "Sign in with GitHub" OAuth App (M6): `GITHUB_OAUTH_CLIENT_ID` + `GITHUB_OAUTH_CLIENT_SECRET`
			 * (or resolved from `GITHUB_OAUTH_CLIENT_SECRET_SECRET_ARN`). Undefined when either is
			 * missing — the GitHub sign-in routes answer 404 and the magic link is the only way in.
			 */
			githubOauth?: { clientId: string; clientSecret: string }
			/**
			 * Resident usage-based billing (M8): the Stripe billing meter's `event_name` the
			 * month's billable cents are reported under (`RESIDENT_USAGE_METER_EVENT`) and, for
			 * reference, the metered price id customers are subscribed to (`RESIDENT_USAGE_PRICE_ID`)
			 */
			residentBilling: {
				meterEvent: string
				priceId?: string
			}
			/**
			 * Per-customer AWS account onboarding (org-accounts.md #4). When false (default) the
			 * `provisionCustomerAccount` onboarding step is a no-op — the account-vending path stays
			 * dark until an operator enables it (`PROVISION_CUSTOMER_ACCOUNTS=true`) and the real vend
			 * has been rehearsed once with Hasse (CreateAccount makes a real, slow, 90-day account).
			 */
			provisionAccounts: boolean
			/**
			 * Delivered-preview support (Gate C): `tokenAudience` is the `aud` of tokens minted for
			 * delivered preview apps (`PREVIEW_TOKEN_AUDIENCE`, default `preview`) — it MUST differ
			 * from `authAudience`, or a minted preview token would be valid against this api itself;
			 * the preview-token route refuses to mint when they collide. `dbAdminUrl`
			 * (`PREVIEW_DB_ADMIN_URL`) overrides the admin connection per-delivery database
			 * provisioning runs on (default: the platform database connection), and `dbHost`
			 * (`PREVIEW_DB_HOST`, `host[:port]`) overrides the host advertised to delivered
			 * containers (docs/DELIVERED-DB.md).
			 */
			preview: { tokenAudience: string; dbAdminUrl?: string; dbHost?: string }
			/**
			 * Deprovisioning / account-lifecycle wiring (teardown-deprovisioning.md, org-accounts.md).
			 * `enabled` (`ORG_LIFECYCLE_ENABLED=true`) turns on the real AWS clients behind the admin
			 * lifecycle action and the onboarding vend; while off, the admin action still transitions
			 * the DB lifecycle and its deprovision runs against an empty world (dry-run everywhere).
			 * `graceDays` is how long a `suspended` order waits before the sweep promotes it to
			 * `torn_down`. `region` / `customersOuId` target the org's AWS.
			 */
			orgLifecycle: {
				enabled: boolean
				region: string
				customersOuId?: string
				graceDays: number
			}
			/** Infra handles (set by the CDK web stack) */
			infra: {
				databaseSecretArn?: string
				/**
				 * Url the build container reports to (`JOB_API_URL`: the ALB, http without a custom
				 * domain). Defaults to the issuer url, which is the api's own url everywhere.
				 */
				jobApiUrl: string
				/**
				 * `NO_PROXY` for the job container (`JOB_NO_PROXY`): the task definition's list plus
				 * the api host, so reports bypass the egress-proxy sidecar. Undefined → not overridden.
				 */
				jobNoProxy?: string
				artifactsBucket?: string
				jobsClusterArn?: string
				jobTaskDefinitionArn?: string
				jobSubnetIds: string[]
				jobSecurityGroupId?: string
				stripeSecretKeySecretArn?: string
				stripeWebhookSecretSecretArn?: string
			}
		}
	}
}

const required = ['AUTH_AUDIENCE'] as const

/** Meter event name unless configured: value = billable US cents */
export const defaultResidentMeterEvent = 'resident_usage_usd_cents'

/** Grace window (days) a suspended order waits before the sweep tears it down; default 30. */
export const defaultLifecycleGraceDays = 30

/** Parses `LIFECYCLE_GRACE_DAYS`; a missing / non-positive / non-numeric value falls back to the default. */
export const parseGraceDays = (value: string | undefined): number => {
	const parsed = Number(value)
	return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : defaultLifecycleGraceDays
}

/**
 * Secrets Manager values are either the raw string or a JSON object with a single key
 * (the CDK placeholders are created that way). Multi-key JSON (e.g. a JWK) is returned as-is.
 * Returns undefined for empty placeholders.
 */
export const parseSecretString = (value: string | undefined) => {
	const trimmed = value?.trim()
	if (!trimmed) return undefined
	if (!trimmed.startsWith('{')) return trimmed
	try {
		const parsed = JSON.parse(trimmed) as Record<string, unknown>
		const entries = Object.values(parsed)
		if (entries.length !== 1) return trimmed
		const [first] = entries
		return typeof first === 'string' && first.trim() ? first.trim() : undefined
	} catch {
		return trimmed
	}
}

const parseList = (value: string | undefined) =>
	value
		?.split(',')
		.map(entry => entry.trim().toLowerCase())
		.filter(Boolean) ?? []

/** `id:token,id:token` → map; entries without both halves are skipped */
export const parseInstallations = (value: string | undefined): Record<string, string> =>
	Object.fromEntries(
		(value ?? '')
			.split(',')
			.map(entry => entry.trim())
			.filter(Boolean)
			.map(entry => {
				const separator = entry.indexOf(':')
				return separator > 0
					? [entry.slice(0, separator).trim(), entry.slice(separator + 1).trim()]
					: ['', '']
			})
			.filter(([id, token]) => id && token)
	)

const isEmailTransport = (value: unknown): value is EmailTransport =>
	typeof value === 'string' && (emailTransports as readonly string[]).includes(value)

const parseEmailTransport = (value: string | undefined, env: string): EmailTransport => {
	if (isEmailTransport(value)) return value
	if (value) throw new Error(`EMAIL_TRANSPORT must be one of: ${emailTransports.join(', ')}`)
	return env === 'live' ? 'ses' : 'log'
}

/**
 * Reads configuration from the environment; secrets referenced by ARN are resolved from
 * Secrets Manager once at startup. Consumers only depend on `app.secrets`.
 */
const plugin: FastifyPluginAsync = async app => {
	const missing = required.filter(name => !process.env[name])
	if (missing.length) {
		throw new Error(`Missing required environment variables: ${missing.join(', ')}`)
	}

	const resolveSecret = async (envName: string, arnEnvName: string) => {
		const fromEnv = process.env[envName]?.trim()
		if (fromEnv) return fromEnv
		const arn = process.env[arnEnvName]
		if (!arn) return undefined
		try {
			const client = new SecretsManagerClient({})
			const result = await client.send(new GetSecretValueCommand({ SecretId: arn }))
			client.destroy()
			const value = parseSecretString(result.SecretString)
			if (!value) app.log.warn({ arn }, `${envName}: secret is an empty placeholder`)
			return value
		} catch (error) {
			app.log.warn({ err: error, arn }, `${envName}: could not resolve secret from Secrets Manager`)
			return undefined
		}
	}

	const env = process.env.ENV || 'local'
	const appUrl = process.env.APP_URL || 'http://localhost:5173'
	const port = process.env.PORT || '5174'
	const authIssuer = process.env.AUTH_ISSUER || `http://localhost:${port}`

	const githubClientId = process.env.GITHUB_OAUTH_CLIENT_ID?.trim()
	const githubClientSecret = githubClientId
		? await resolveSecret('GITHUB_OAUTH_CLIENT_SECRET', 'GITHUB_OAUTH_CLIENT_SECRET_SECRET_ARN')
		: undefined

	app.decorate('secrets', {
		env,
		appUrl,
		portalUrl: process.env.PORTAL_URL || appUrl,
		authIssuer,
		authAudience: process.env.AUTH_AUDIENCE!,
		authJwtPrivateKey: await resolveSecret(
			'AUTH_JWT_PRIVATE_KEY',
			'AUTH_JWT_PRIVATE_KEY_SECRET_ARN'
		),
		authAdminEmails: parseList(process.env.AUTH_ADMIN_EMAILS),
		emailTransport: parseEmailTransport(process.env.EMAIL_TRANSPORT, env),
		emailFrom: process.env.AUTH_EMAIL_FROM || 'noreply@mjukvaruhuset.se',
		anthropicApiKey: await resolveSecret('ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY_SECRET_ARN'),
		specModel: process.env.SPEC_MODEL || undefined,
		sentryDsn: await resolveSecret('SENTRY_DSN', 'SENTRY_DSN_SECRET_ARN'),
		residentInstallations: parseInstallations(
			await resolveSecret('RESIDENT_INSTALLATIONS', 'RESIDENT_INSTALLATIONS_SECRET_ARN')
		),
		githubOauth:
			githubClientId && githubClientSecret
				? { clientId: githubClientId, clientSecret: githubClientSecret }
				: undefined,
		residentBilling: {
			meterEvent: process.env.RESIDENT_USAGE_METER_EVENT || defaultResidentMeterEvent,
			priceId: process.env.RESIDENT_USAGE_PRICE_ID || undefined,
		},
		provisionAccounts: process.env.PROVISION_CUSTOMER_ACCOUNTS === 'true',
		preview: {
			tokenAudience: process.env.PREVIEW_TOKEN_AUDIENCE || 'preview',
			dbAdminUrl: process.env.PREVIEW_DB_ADMIN_URL?.trim() || undefined,
			dbHost: process.env.PREVIEW_DB_HOST?.trim() || undefined,
		},
		orgLifecycle: {
			enabled: process.env.ORG_LIFECYCLE_ENABLED === 'true',
			region: process.env.ORG_AWS_REGION || 'eu-north-1',
			customersOuId: process.env.ORG_CUSTOMERS_OU_ID || undefined,
			graceDays: parseGraceDays(process.env.LIFECYCLE_GRACE_DAYS),
		},
		infra: {
			databaseSecretArn: process.env.DATABASE_SECRET_ARN,
			jobApiUrl: process.env.JOB_API_URL || authIssuer,
			jobNoProxy: process.env.JOB_NO_PROXY || undefined,
			artifactsBucket: process.env.ARTIFACTS_BUCKET,
			jobsClusterArn: process.env.JOBS_CLUSTER_ARN,
			jobTaskDefinitionArn: process.env.JOB_TASK_DEFINITION_ARN,
			jobSubnetIds: process.env.JOB_SUBNET_IDS?.split(',').filter(Boolean) ?? [],
			jobSecurityGroupId: process.env.JOB_SECURITY_GROUP_ID,
			stripeSecretKeySecretArn: process.env.STRIPE_SECRET_KEY_SECRET_ARN,
			stripeWebhookSecretSecretArn: process.env.STRIPE_WEBHOOK_SECRET_SECRET_ARN,
		},
	})
}

export default fp(plugin, { name: '#internal/secrets' })

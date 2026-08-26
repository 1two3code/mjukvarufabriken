import fp from 'fastify-plugin'
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'

import type { FastifyPluginAsync } from 'fastify'

declare module 'fastify' {
	interface FastifyInstance {
		secrets: {
			/** Public URL of the SPA, used for CORS */
			appUrl: string
			/** JWKS endpoint of the identity provider */
			authJwksUrl: string
			/** Expected `iss` claim */
			authIssuer: string
			/** Expected `aud` claim */
			authAudience: string
			/**
			 * Anthropic API key for the spec engine. From `ANTHROPIC_API_KEY`, or resolved from
			 * Secrets Manager via `ANTHROPIC_API_KEY_SECRET_ARN` at startup. Undefined when neither
			 * is set — the api still boots, the spec engine reports itself as unavailable.
			 */
			anthropicApiKey?: string
			/** Model id override for the spec engine (`SPEC_MODEL`) */
			specModel?: string
			/** Infra handles (set by the CDK web stack; unused until M3/M5) */
			infra: {
				databaseSecretArn?: string
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

const required = ['AUTH_JWKS_URL', 'AUTH_ISSUER', 'AUTH_AUDIENCE'] as const

/**
 * Secrets Manager values are either the raw string or a JSON object with a single key
 * (the CDK placeholders are created that way). Returns undefined for empty placeholders.
 */
const parseSecretString = (value: string | undefined) => {
	const trimmed = value?.trim()
	if (!trimmed) return undefined
	if (!trimmed.startsWith('{')) return trimmed
	try {
		const parsed = JSON.parse(trimmed) as Record<string, unknown>
		const first = Object.values(parsed).find(entry => typeof entry === 'string' && entry.trim())
		return typeof first === 'string' ? first.trim() : undefined
	} catch {
		return trimmed
	}
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

	app.decorate('secrets', {
		appUrl: process.env.APP_URL ?? 'http://localhost:5173',
		authJwksUrl: process.env.AUTH_JWKS_URL!,
		authIssuer: process.env.AUTH_ISSUER!,
		authAudience: process.env.AUTH_AUDIENCE!,
		anthropicApiKey: await resolveSecret('ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY_SECRET_ARN'),
		specModel: process.env.SPEC_MODEL || undefined,
		infra: {
			databaseSecretArn: process.env.DATABASE_SECRET_ARN,
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

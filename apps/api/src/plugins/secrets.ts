import fp from 'fastify-plugin'

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
 * Reads configuration from the environment. Swap the body of this plugin for a
 * secrets manager / parameter store lookup when deploying — consumers only depend
 * on `app.secrets`.
 */
const plugin: FastifyPluginAsync = async app => {
	const missing = required.filter(name => !process.env[name])
	if (missing.length) {
		throw new Error(`Missing required environment variables: ${missing.join(', ')}`)
	}

	app.decorate('secrets', {
		appUrl: process.env.APP_URL ?? 'http://localhost:5173',
		authJwksUrl: process.env.AUTH_JWKS_URL!,
		authIssuer: process.env.AUTH_ISSUER!,
		authAudience: process.env.AUTH_AUDIENCE!,
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

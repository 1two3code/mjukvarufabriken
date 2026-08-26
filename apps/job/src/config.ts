import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import { connectionStringFromSecret } from '@mf/db'

import type { DatabaseSecret } from '@mf/db'

export type JobConfig = {
	jobId: string
	databaseUrl: string
	anthropicApiKey: string
	/** Where the customer repo is seeded (`WORK_DIR`, default /work) */
	workDir: string
	/** Baked-in golden template the repo starts from (`TEMPLATE_DIR`) */
	templateDir: string
	planModel?: string
	workerModel?: string
	env: string
	/** M5 delivery (all optional: a missing value fails the delivery step, never the build) */
	delivery: {
		/** `GITHUB_TOKEN` or resolved from `GITHUB_TOKEN_SECRET_ARN`; undefined for an empty placeholder */
		githubToken?: string
		githubOrg?: string
		/** `APPRUNNER_CONNECTION_ARN` — the App Runner GitHub connection (TODO-EXTERNAL) */
		appRunnerConnectionArn?: string
		appRunnerInstanceRoleArn?: string
		/** `ARTIFACTS_BUCKET` — bundle + SPA build destination */
		artifactsBucket?: string
		/** `DELIVERY_DRY_RUN=1`: log the GitHub / App Runner / S3 calls instead of making them */
		dryRun: boolean
	}
}

const readSecret = async (arn: string) => {
	const client = new SecretsManagerClient({})
	try {
		const result = await client.send(new GetSecretValueCommand({ SecretId: arn }))
		return result.SecretString ?? ''
	} finally {
		client.destroy()
	}
}

/** Raw string, or a single-key JSON object (how the CDK placeholders are created) */
const parseSecretString = (value: string) => {
	const trimmed = value.trim()
	if (!trimmed.startsWith('{')) return trimmed
	const parsed = JSON.parse(trimmed) as Record<string, unknown>
	const values = Object.values(parsed)
	return values.length === 1 && typeof values[0] === 'string' ? values[0] : trimmed
}

const resolveDatabaseUrl = async () => {
	if (process.env.DATABASE_URL) return process.env.DATABASE_URL
	const arn = process.env.DATABASE_SECRET_ARN
	if (!arn) throw new Error('DATABASE_URL or DATABASE_SECRET_ARN is required')
	return connectionStringFromSecret(JSON.parse(await readSecret(arn)) as DatabaseSecret)
}

const resolveAnthropicKey = async () => {
	if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY
	const arn = process.env.ANTHROPIC_API_KEY_SECRET_ARN
	if (!arn) throw new Error('ANTHROPIC_API_KEY or ANTHROPIC_API_KEY_SECRET_ARN is required')
	const key = parseSecretString(await readSecret(arn))
	if (!key) throw new Error('anthropic-api-key secret is an empty placeholder')
	return key
}

/** Optional secret: env value, else Secrets Manager via the ARN, else undefined (empty placeholder too) */
const resolveOptionalSecret = async (envName: string, arnEnvName: string) => {
	const fromEnv = process.env[envName]?.trim()
	if (fromEnv) return fromEnv
	const arn = process.env[arnEnvName]
	if (!arn) return undefined
	return parseSecretString(await readSecret(arn)) || undefined
}

/**
 * Only the job id, the database and the Anthropic key are needed — no customer secrets are
 * ever passed into the container. `JOB_ID` comes from the api's `ecs:RunTask` override or the
 * `npm run job:dev -- <id>` argument.
 */
export const loadConfig = async (argv: string[]): Promise<JobConfig> => {
	const jobId = argv[0] || process.env.JOB_ID
	if (!jobId) throw new Error('JOB_ID env or a job id argument is required')
	return {
		jobId,
		databaseUrl: await resolveDatabaseUrl(),
		anthropicApiKey: await resolveAnthropicKey(),
		workDir: process.env.WORK_DIR || '/work',
		templateDir: process.env.TEMPLATE_DIR || '/usr/src/templates/web',
		planModel: process.env.PLAN_MODEL || undefined,
		workerModel: process.env.WORKER_MODEL || undefined,
		env: process.env.ENV || 'local',
		delivery: {
			githubToken: await resolveOptionalSecret('GITHUB_TOKEN', 'GITHUB_TOKEN_SECRET_ARN'),
			githubOrg: process.env.GITHUB_ORG || undefined,
			appRunnerConnectionArn: process.env.APPRUNNER_CONNECTION_ARN || undefined,
			appRunnerInstanceRoleArn: process.env.APPRUNNER_INSTANCE_ROLE_ARN || undefined,
			artifactsBucket: process.env.ARTIFACTS_BUCKET || undefined,
			dryRun: ['1', 'true'].includes(process.env.DELIVERY_DRY_RUN ?? ''),
		},
	}
}

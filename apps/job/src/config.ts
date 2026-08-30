import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'

/**
 * Where the job reports to. `api`: the per-job endpoint (`API_URL` + `JOB_TOKEN`, what the
 * api's RunTask override sets — Fargate). `db`: Postgres directly (`DATABASE_URL`, local
 * `npm run job:dev`). The api mode wins when both are present.
 */
export type ReportTarget =
	{ mode: 'api'; apiUrl: string; token: string } | { mode: 'db'; databaseUrl: string }

export type JobConfig = {
	jobId: string
	report: ReportTarget
	anthropicApiKey: string
	/** Where the customer repo is seeded (`WORK_DIR`, default /work) */
	workDir: string
	/** Baked-in golden template the repo starts from (`TEMPLATE_DIR`) */
	templateDir: string
	planModel?: string
	workerModel?: string
	env: string
	/**
	 * Record a replay cassette of this run's two model seams (planner + sessions) to this directory
	 * (`MF_CASSETTE=<dir>` or `--record <dir>`). Off by default; a normal run is unaffected. The
	 * captured cassette replays offline through the real `runJob` with no tokens (see docs/TESTING.md).
	 */
	cassetteDir?: string
	/** M5 delivery (all optional: a missing value fails the delivery step, never the build) */
	delivery: {
		/** GitHub App installation (app id + private key + installation id); undefined until all three resolve */
		githubApp?: { appId: string; privateKey: string; installationId: number }
		githubOrg?: string
		/** `ECR_REPOSITORY_URI` — ECR repo the built customer image is pushed to (ECS Express deploy) */
		ecrRepositoryUri?: string
		/** `CODEBUILD_PROJECT` — CodeBuild project that builds + pushes the image */
		codeBuildProject?: string
		/** `EXPRESS_EXECUTION_ROLE_ARN` — task-execution role for the Express service */
		expressExecutionRoleArn?: string
		/** `EXPRESS_INFRASTRUCTURE_ROLE_ARN` — infrastructure role for the Express service */
		expressInfrastructureRoleArn?: string
		/** `ECS_CLUSTER` — cluster the Express service runs on (default `default`) */
		cluster?: string
		/** `PREVIEW_AUTH_ISSUER` (+ `_JWKS_URL`, `_AUDIENCE`) — IdP of the preview api; no deploy without it */
		previewAuth?: { issuer: string; jwksUrl: string; audience: string }
		/** `ARTIFACTS_BUCKET` — bundle + SPA build destination */
		artifactsBucket?: string
		/**
		 * `ARTIFACTS_ROLE_ARN` — role this job assumes (session-policy-scoped to its own prefix/key
		 * via `jobId`) to upload; the task role itself has no S3 permission (M3 hardening #1)
		 */
		artifactsRoleArn?: string
		/** `DELIVERY_DRY_RUN=1`: log the GitHub / ECS Express / S3 calls instead of making them */
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

export const resolveReportTarget = (env: NodeJS.ProcessEnv = process.env): ReportTarget => {
	const apiUrl = env.API_URL?.trim()
	const token = env.JOB_TOKEN?.trim()
	if (apiUrl && token) return { mode: 'api', apiUrl, token }
	if (apiUrl || token) throw new Error('API_URL and JOB_TOKEN must be set together')
	const databaseUrl = env.DATABASE_URL?.trim()
	if (databaseUrl) return { mode: 'db', databaseUrl }
	throw new Error('API_URL + JOB_TOKEN (Fargate) or DATABASE_URL (local) is required')
}

const resolveAnthropicKey = async () => {
	if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY
	const arn = process.env.ANTHROPIC_API_KEY_SECRET_ARN
	if (!arn) throw new Error('ANTHROPIC_API_KEY or ANTHROPIC_API_KEY_SECRET_ARN is required')
	const key = parseSecretString(await readSecret(arn))
	if (!key) throw new Error('anthropic-api-key secret is an empty placeholder')
	return key
}

/**
 * `PREVIEW_AUTH_ISSUER` is the IdP the preview api verifies tokens against (our own api: it
 * publishes `/.well-known/jwks.json`); JWKS URL and audience default from it
 */
const previewAuthFromEnv = () => {
	const issuer = process.env.PREVIEW_AUTH_ISSUER?.trim()
	if (!issuer) return undefined
	return {
		issuer,
		jwksUrl: process.env.PREVIEW_AUTH_JWKS_URL || `${issuer.replace(/\/$/, '')}/.well-known/jwks.json`,
		audience: process.env.PREVIEW_AUTH_AUDIENCE || 'preview',
	}
}

/**
 * GitHub App credentials for delivery (repo create/push/transfer): app id + installation id from
 * env, private key from `GITHUB_APP_PRIVATE_KEY` or `GITHUB_APP_PRIVATE_KEY_SECRET_ARN`. Undefined
 * unless all three resolve — then the delivery `repo` step fails closed with a clear reason.
 */
const resolveGithubApp = async () => {
	const appId = process.env.GITHUB_APP_ID?.trim()
	const installationId = Number(process.env.GITHUB_APP_INSTALLATION_ID?.trim())
	const privateKey = await resolveOptionalSecret(
		'GITHUB_APP_PRIVATE_KEY',
		'GITHUB_APP_PRIVATE_KEY_SECRET_ARN'
	)
	if (!appId || !privateKey || !Number.isInteger(installationId) || installationId <= 0) {
		return undefined
	}
	return { appId, privateKey, installationId }
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
 * Only the job id, the report target and the Anthropic key are needed — no customer secrets
 * and no database credential are ever passed into the container on Fargate. `JOB_ID`,
 * `JOB_TOKEN` and `API_URL` come from the api's `ecs:RunTask` override; locally the id is the
 * `npm run job:dev -- <id>` argument.
 */
export const loadConfig = async (argv: string[]): Promise<JobConfig> => {
	// `--record <dir>` (or `MF_CASSETTE`) is an optional record seam; strip it from the positionals
	const recordFlag = argv.indexOf('--record')
	const cassetteDir = process.env.MF_CASSETTE || (recordFlag >= 0 ? argv[recordFlag + 1] : undefined)
	const positional = argv.filter(
		(arg, index) => !arg.startsWith('--') && !(recordFlag >= 0 && index === recordFlag + 1)
	)
	const jobId = positional[0] || process.env.JOB_ID
	if (!jobId) throw new Error('JOB_ID env or a job id argument is required')
	return {
		jobId,
		cassetteDir,
		report: resolveReportTarget(),
		anthropicApiKey: await resolveAnthropicKey(),
		workDir: process.env.WORK_DIR || '/work',
		templateDir: process.env.TEMPLATE_DIR || '/usr/src/templates/web',
		planModel: process.env.PLAN_MODEL || undefined,
		workerModel: process.env.WORKER_MODEL || undefined,
		env: process.env.ENV || 'local',
		delivery: {
			githubApp: await resolveGithubApp(),
			githubOrg: process.env.GITHUB_ORG || undefined,
			ecrRepositoryUri: process.env.ECR_REPOSITORY_URI || undefined,
			codeBuildProject: process.env.CODEBUILD_PROJECT || undefined,
			expressExecutionRoleArn: process.env.EXPRESS_EXECUTION_ROLE_ARN || undefined,
			expressInfrastructureRoleArn: process.env.EXPRESS_INFRASTRUCTURE_ROLE_ARN || undefined,
			cluster: process.env.ECS_CLUSTER || undefined,
			previewAuth: previewAuthFromEnv(),
			artifactsBucket: process.env.ARTIFACTS_BUCKET || undefined,
			artifactsRoleArn: process.env.ARTIFACTS_ROLE_ARN || undefined,
			dryRun: ['1', 'true'].includes(process.env.DELIVERY_DRY_RUN ?? ''),
		},
	}
}

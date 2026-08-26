import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'

import { parsePriceOverrides } from '#/pricing.ts'

import type { ModelPrice } from '#/pricing.ts'

export type ResidentConfig = {
	/** `RESIDENT_INSTALLATION_ID` — what the factory bills; one per customer repo */
	installationId: string
	/** `GITHUB_REPOSITORY`: `owner/name`, the one repository this resident may touch */
	repository: string
	githubToken?: string
	anthropicApiKey?: string
	/** `RESIDENT_MONTHLY_TOKENS` — hard monthly cap (budget-weighted tokens) */
	monthlyTokens: number
	/** `RESIDENT_TASK_TOKENS` — per-task budget, capped by what the month has left */
	taskTokens: number
	taskDurationMinutes: number
	taskWorkers: number
	/** `RESIDENT_PAUSED=1` starts paused (the stored flag wins once set through the endpoint) */
	pausedByEnv: boolean
	/** `RESIDENT_BUCKET` — audit + metering; unset → in-memory store (dry-run / local) */
	bucket?: string
	region?: string
	/** `FACTORY_API_URL` + `FACTORY_TOKEN`; unset → usage records stay in the bucket */
	factory?: { apiUrl: string; token: string }
	/** `RESIDENT_ADMIN_TOKEN` — bearer for the control endpoints; unset → no token required */
	adminToken?: string
	pollIntervalMs: number
	/** `RESIDENT_DRY_RUN=1`: no GitHub, no S3, no model — fakes only (smoke test of the service) */
	dryRun: boolean
	workDir: string
	planModel?: string
	workerModel?: string
	prices: Record<string, ModelPrice>
	port: number
	address: string
}

export const defaultMonthlyTokens = 50_000_000
export const defaultTaskTokens = 6_000_000

const readSecret = async (arn: string) => {
	const client = new SecretsManagerClient({})
	try {
		const result = await client.send(new GetSecretValueCommand({ SecretId: arn }))
		return result.SecretString ?? ''
	} finally {
		client.destroy()
	}
}

/** The key the CDK stack puts into every secret it generates as a placeholder (`infra/resident`) */
export const placeholderSecretKey = 'placeholder'

/**
 * Raw string, or a single-key JSON object. A JSON object carrying `placeholder` is the value the
 * CDK stack generated at deploy time and the customer has not replaced yet: not configured.
 */
export const parseSecretString = (value: string) => {
	const trimmed = value.trim()
	if (!trimmed.startsWith('{')) return trimmed
	try {
		const parsed = JSON.parse(trimmed) as Record<string, unknown>
		if (placeholderSecretKey in parsed) return ''
		const values = Object.values(parsed)
		return values.length === 1 && typeof values[0] === 'string' ? values[0].trim() : trimmed
	} catch {
		return trimmed
	}
}

/** Env value, else Secrets Manager via the `*_SECRET_ARN` variable, else undefined (empty placeholder too) */
const resolveOptionalSecret = async (env: NodeJS.ProcessEnv, name: string) => {
	const fromEnv = env[name]?.trim()
	if (fromEnv) return fromEnv
	const arn = env[`${name}_SECRET_ARN`]
	if (!arn) return undefined
	return parseSecretString(await readSecret(arn)) || undefined
}

const flag = (value: string | undefined) => ['1', 'true', 'yes'].includes(value?.trim() ?? '')

const integer = (value: string | undefined, fallback: number) => {
	const parsed = Number(value)
	return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

export const loadConfig = async (env: NodeJS.ProcessEnv = process.env): Promise<ResidentConfig> => {
	const dryRun = flag(env.RESIDENT_DRY_RUN)
	const repository = env.GITHUB_REPOSITORY?.trim() || (dryRun ? 'example/dry-run' : '')
	if (!repository) throw new Error('GITHUB_REPOSITORY (owner/name) is required')
	const factoryToken = await resolveOptionalSecret(env, 'FACTORY_TOKEN')
	const factoryApiUrl = env.FACTORY_API_URL?.trim()
	return {
		installationId: env.RESIDENT_INSTALLATION_ID?.trim() || repository.replace('/', '--'),
		repository,
		githubToken: await resolveOptionalSecret(env, 'GITHUB_TOKEN'),
		anthropicApiKey: await resolveOptionalSecret(env, 'ANTHROPIC_API_KEY'),
		monthlyTokens: integer(env.RESIDENT_MONTHLY_TOKENS, defaultMonthlyTokens),
		taskTokens: integer(env.RESIDENT_TASK_TOKENS, defaultTaskTokens),
		taskDurationMinutes: integer(env.RESIDENT_TASK_MINUTES, 120),
		taskWorkers: integer(env.RESIDENT_TASK_WORKERS, 2),
		pausedByEnv: flag(env.RESIDENT_PAUSED),
		bucket: env.RESIDENT_BUCKET?.trim() || undefined,
		region: env.AWS_REGION?.trim() || undefined,
		factory:
			factoryApiUrl && factoryToken ? { apiUrl: factoryApiUrl, token: factoryToken } : undefined,
		adminToken: await resolveOptionalSecret(env, 'RESIDENT_ADMIN_TOKEN'),
		pollIntervalMs: integer(env.RESIDENT_POLL_INTERVAL_MS, 60_000),
		dryRun,
		workDir: env.WORK_DIR?.trim() || '/work',
		planModel: env.PLAN_MODEL?.trim() || undefined,
		workerModel: env.WORKER_MODEL?.trim() || undefined,
		prices: parsePriceOverrides(env.RESIDENT_PRICES_JSON),
		port: integer(env.PORT, 5176),
		address: env.ADDRESS?.trim() || '0.0.0.0',
	}
}

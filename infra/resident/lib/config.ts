import type { App } from 'aws-cdk-lib'

export type ResidentConfig = {
	/** `owner/name` of the one GitHub repository the resident may work on */
	repository: string
	/** What the factory bills; defaults to `owner--name` */
	installationId: string
	/** Hard monthly cap, budget-weighted tokens */
	monthlyTokens: number
	/** Per-task budget (defaults to the M size class, 6M) */
	taskTokens: number
	/** Where daily usage records are reported (bearer = the `factory-token` secret) */
	factoryApiUrl: string
	/** Put the control api behind a public ALB (default: reachable inside the VPC only) */
	exposeApi: boolean
	/** Fargate sizing */
	cpu: number
	memoryMiB: number
	/** Worker / planner model overrides, passed through as env */
	workerModel?: string
	planModel?: string
	account?: string
	region?: string
}

const contextString = (app: App, key: string) => {
	const value = app.node.tryGetContext(key) as unknown
	return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

const contextNumber = (app: App, key: string, fallback: number) => {
	const parsed = Number(contextString(app, key))
	return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

/**
 * Everything comes from CDK context (`-c repository=acme/shop`, or `cdk.json`) or the
 * environment, so the customer never edits code: `cdk deploy -c repository=acme/shop`.
 * Without a repository (plain `cdk synth` in CI) a placeholder keeps synth green.
 */
export const loadConfig = (app: App): ResidentConfig => {
	const repository =
		contextString(app, 'repository') || process.env.RESIDENT_REPOSITORY || 'example/repository'
	const account = process.env.CDK_DEFAULT_ACCOUNT
	return {
		repository,
		installationId: contextString(app, 'installationId') || repository.replace('/', '--'),
		monthlyTokens: contextNumber(app, 'monthlyTokens', 50_000_000),
		taskTokens: contextNumber(app, 'taskTokens', 6_000_000),
		factoryApiUrl: contextString(app, 'factoryApiUrl') || 'https://api.mjukvaruhuset.se',
		exposeApi: contextString(app, 'exposeApi') === 'true',
		cpu: contextNumber(app, 'cpu', 2048),
		memoryMiB: contextNumber(app, 'memoryMiB', 4096),
		workerModel: contextString(app, 'workerModel'),
		planModel: contextString(app, 'planModel'),
		account,
		region: account ? (process.env.CDK_DEFAULT_REGION ?? 'eu-north-1') : undefined,
	}
}

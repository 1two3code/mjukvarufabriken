import type { App } from 'aws-cdk-lib'

export type OrgConfig = {
	/**
	 * Id of the organization root the `Customers` OU hangs off. Known offline (recorded in
	 * docs/backlog/org-accounts.md); overridable with `-c rootId=r-xxxx`. A hardcoded default keeps
	 * `cdk synth` green with no AWS calls.
	 */
	rootId: string
	/**
	 * Regions the SCP permits customer accounts to operate in. `eu-north-1` is where everything we
	 * run lives; `us-east-1` is kept for the two services that are only reachable there — ACM
	 * certificates fronting CloudFront, and AWS Budgets.
	 */
	allowedRegions: string[]
	account?: string
	region?: string
}

/** The recorded root id of org `o-6lnoiunxku` (management account 814967776290). */
export const DEFAULT_ROOT_ID = 'r-hh2k'
/** eu-north-1 for our workloads; us-east-1 for ACM-for-CloudFront and Budgets. */
export const DEFAULT_ALLOWED_REGIONS = ['eu-north-1', 'us-east-1']

const contextString = (app: App, key: string) => {
	const value = app.node.tryGetContext(key) as unknown
	return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/**
 * Everything comes from CDK context (`-c rootId=r-xxxx`) or a safe default, so a plain
 * `cdk synth` in CI stays offline and green: no `organizations:ListRoots` lookup at synth time.
 */
export const loadConfig = (app: App): OrgConfig => {
	const account = process.env.CDK_DEFAULT_ACCOUNT
	const regions = contextString(app, 'allowedRegions')
		?.split(',')
		.map(region => region.trim())
		.filter(Boolean)
	return {
		rootId: contextString(app, 'rootId') || process.env.ORG_ROOT_ID || DEFAULT_ROOT_ID,
		allowedRegions: regions?.length ? regions : DEFAULT_ALLOWED_REGIONS,
		account,
		region: account ? (process.env.CDK_DEFAULT_REGION ?? 'eu-north-1') : undefined,
	}
}

import {
	createAppRunnerDeployClient,
	createDryRunDeployClient,
	createFakeDeployClient,
} from './appRunner.ts'
import {
	createDryRunArtifactStore,
	createFakeArtifactStore,
	createS3ArtifactStore,
} from './artifacts.ts'
import {
	createDryRunGitHubClient,
	createFakeGitHubClient,
	createOctokitGitHubClient,
	defaultGitHubOrg,
} from './github.ts'
import { createFakeProseWriter, createLiveProseWriter } from './prose.ts'

import type { DeliveryClients } from './types.ts'

export * from './appRunner.ts'
export * from './artifacts.ts'
export * from './bundle.ts'
export * from './deliver.ts'
export * from './docs.ts'
export * from './github.ts'
export * from './prose.ts'
export * from './types.ts'

// MARK: Slug

/** `mjukvaruhuset/<slug>`: lower-case letters, digits and dashes, from the order id / app name */
export const slugify = (text: string, fallback = 'app') => {
	const slug = text
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 60)
		.replace(/-+$/, '')
	return slug || fallback
}

/** Application name for the docs: the first sentence of the spec goal, title-cased-ish */
export const appNameOf = (goal: string, fallback = 'Your application') => {
	const first = goal.split(/[.!?\n]/)[0]?.trim() ?? ''
	const name = first.length > 80 ? `${first.slice(0, 77).trimEnd()}…` : first
	return name ? name[0]!.toUpperCase() + name.slice(1) : fallback
}

// MARK: Live clients

export type LiveDeliveryOptions = {
	/** `GITHUB_TOKEN` (resolved from `GITHUB_TOKEN_SECRET_ARN` by apps/job) */
	githubToken?: string
	githubOrg?: string
	/** `APPRUNNER_CONNECTION_ARN` — without it the deploy step reports a reason and `deployUrl` null */
	appRunnerConnectionArn?: string
	appRunnerInstanceRoleArn?: string
	/** `ARTIFACTS_BUCKET` + region */
	artifactsBucket?: string
	region?: string
	workerModel?: string
	/** Log instead of calling GitHub / App Runner / S3 */
	dryRun?: boolean
	log?: (line: string) => void
}

const notConfigured = (what: string) => async () => {
	throw new Error(`${what} is not configured (TODO-EXTERNAL)`)
}

/**
 * The real clients from the environment, or the dry-run ones that only log. Missing
 * configuration turns into a step failure at delivery time (never a crash at start-up), so a
 * job without a GitHub token still runs its build and gates and fails closed at delivery.
 */
export const createLiveDeliveryClients = ({
	githubToken,
	githubOrg = process.env.GITHUB_ORG || defaultGitHubOrg,
	appRunnerConnectionArn,
	appRunnerInstanceRoleArn,
	artifactsBucket,
	region = process.env.AWS_REGION || 'eu-north-1',
	workerModel,
	dryRun = false,
	log = line => console.log(JSON.stringify({ message: line })),
}: LiveDeliveryOptions): DeliveryClients => {
	if (dryRun) {
		return {
			github: createDryRunGitHubClient(log),
			deploy: createDryRunDeployClient(log),
			artifacts: createDryRunArtifactStore(artifactsBucket ?? 'mf-artifacts-dry-run', log),
			prose: process.env.ANTHROPIC_API_KEY
				? createLiveProseWriter({ model: workerModel })
				: undefined,
			githubOrg,
			dryRun: true,
		}
	}
	return {
		github: githubToken
			? createOctokitGitHubClient(githubToken)
			: {
					createRepo: notConfigured('GITHUB_TOKEN'),
					push: notConfigured('GITHUB_TOKEN'),
					addCollaborator: notConfigured('GITHUB_TOKEN'),
				},
		deploy: appRunnerConnectionArn
			? createAppRunnerDeployClient({
					connectionArn: appRunnerConnectionArn,
					instanceRoleArn: appRunnerInstanceRoleArn,
				})
			: { deployFromRepo: notConfigured('APPRUNNER_CONNECTION_ARN') },
		artifacts: artifactsBucket
			? createS3ArtifactStore(artifactsBucket, region)
			: {
					bucket: '',
					urlOf: key => key,
					putObject: notConfigured('ARTIFACTS_BUCKET'),
				},
		prose: createLiveProseWriter({ model: workerModel }),
		githubOrg,
	}
}

/** Everything faked in memory — what the unit tests and the orchestrator test use */
export const createFakeDeliveryClients = (): DeliveryClients => ({
	github: createFakeGitHubClient(),
	deploy: createFakeDeployClient(),
	artifacts: createFakeArtifactStore(),
	prose: createFakeProseWriter(),
})

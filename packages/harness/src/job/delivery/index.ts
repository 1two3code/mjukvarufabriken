import {
	createDryRunArtifactStore,
	createFakeArtifactStore,
	createS3ArtifactStore,
} from './artifacts.ts'
import { createDryRunBootCheck, createFakeBootCheck } from './bootArtifact.ts'
import {
	createDryRunDeployClient,
	createEcsExpressDeployClient,
	createFakeDeployClient,
	defaultExpressLogGroup,
} from './ecsExpress.ts'
import {
	createDryRunGitHubClient,
	createFakeGitHubClient,
	createOctokitGitHubClient,
	defaultGitHubOrg,
} from './github.ts'
import { createCodeBuildImageBuilder } from './imageBuild.ts'
import { createFakeProseWriter, createLiveProseWriter } from './prose.ts'
import { createWiredSmokeCheck } from './wiredSmoke.ts'

import type { GitHubAppAuth } from './github.ts'
import type { DeliveryClients, PreviewAuth } from './types.ts'

export * from './artifacts.ts'
export * from './bootArtifact.ts'
export * from './wiredSmoke.ts'
export * from './bundle.ts'
export * from './deliver.ts'
export * from './docs.ts'
export * from './ecsExpress.ts'
export * from './github.ts'
export * from './imageBuild.ts'
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
	/** GitHub App installation (app id + private key + installation id), resolved by apps/job */
	githubApp?: GitHubAppAuth
	githubOrg?: string
	/**
	 * ECS Express deploy configuration (from apps/job env). Any missing → the deploy step reports a
	 * reason and `deployUrl` null (never crashes the build):
	 *   `ECR_REPOSITORY_URI`               the ECR repo built images are pushed to
	 *   `CODEBUILD_PROJECT`                the CodeBuild project that builds + pushes the image
	 *   `EXPRESS_EXECUTION_ROLE_ARN`       task-execution role (pull image, write logs)
	 *   `EXPRESS_INFRASTRUCTURE_ROLE_ARN`  infrastructure role (managed ALB provisioning)
	 *   `ECS_CLUSTER`                      cluster the Express service runs on (default `default`)
	 */
	ecrRepositoryUri?: string
	codeBuildProject?: string
	expressExecutionRoleArn?: string
	expressInfrastructureRoleArn?: string
	cluster?: string
	/**
	 * `PREVIEW_AUTH_ISSUER` (+ optional `PREVIEW_AUTH_JWKS_URL`, `PREVIEW_AUTH_AUDIENCE`) — the
	 * IdP the preview api verifies tokens against; without it the deploy step is not attempted
	 */
	previewAuth?: PreviewAuth
	/** `ARTIFACTS_BUCKET` + region */
	artifactsBucket?: string
	/**
	 * This job's id and `ARTIFACTS_ROLE_ARN` (M3 hardening #1) — with both, every S3 write is
	 * scoped to this job's own prefix/key via an assumed-role session policy
	 * (`artifacts.ts#createS3ArtifactStore`); without either, the bucket is written with ambient
	 * credentials as before (local `job:dev`, tests).
	 */
	jobId?: string
	artifactsRoleArn?: string
	region?: string
	workerModel?: string
	/** Log instead of calling GitHub / ECS Express / S3 */
	dryRun?: boolean
	log?: (line: string) => void
}

/** The first missing ECS-Express setting (deploy fails closed with its name), or undefined */
const missingExpressSetting = (options: {
	ecrRepositoryUri?: string
	codeBuildProject?: string
	expressExecutionRoleArn?: string
	expressInfrastructureRoleArn?: string
	previewAuth?: PreviewAuth
}) =>
	!options.ecrRepositoryUri
		? 'ECR_REPOSITORY_URI'
		: !options.codeBuildProject
			? 'CODEBUILD_PROJECT'
			: !options.expressExecutionRoleArn
				? 'EXPRESS_EXECUTION_ROLE_ARN'
				: !options.expressInfrastructureRoleArn
					? 'EXPRESS_INFRASTRUCTURE_ROLE_ARN'
					: !options.previewAuth
						? 'PREVIEW_AUTH_ISSUER'
						: undefined

const notConfigured = (what: string) => async () => {
	throw new Error(`${what} is not configured (TODO-EXTERNAL)`)
}

/**
 * The real clients from the environment, or the dry-run ones that only log. Missing
 * configuration turns into a step failure at delivery time (never a crash at start-up), so a
 * job without a GitHub token still runs its build and gates and fails closed at delivery.
 */
export const createLiveDeliveryClients = ({
	githubApp,
	githubOrg = process.env.GITHUB_ORG || defaultGitHubOrg,
	ecrRepositoryUri,
	codeBuildProject,
	expressExecutionRoleArn,
	expressInfrastructureRoleArn,
	cluster,
	previewAuth,
	artifactsBucket,
	jobId,
	artifactsRoleArn,
	region = process.env.AWS_REGION || 'eu-north-1',
	workerModel,
	dryRun = false,
	log = line => console.log(JSON.stringify({ message: line })),
}: LiveDeliveryOptions): DeliveryClients => {
	const artifactsScope = jobId && artifactsRoleArn ? { jobId, roleArn: artifactsRoleArn } : undefined
	if (dryRun) {
		// Dry-run means "skip the external accounts we do not have yet" — GitHub and ECS Express.
		// The S3 bundle is OUR artifacts bucket (the job task role already writes it) and needs no
		// external prerequisite, so it is uploaded for real whenever a bucket is configured; only
		// without one does it fall back to logging. The repo push / deploy stay faked.
		return {
			github: createDryRunGitHubClient(log),
			deploy: createDryRunDeployClient(log),
			artifacts: artifactsBucket
				? createS3ArtifactStore(artifactsBucket, region, artifactsScope)
				: createDryRunArtifactStore('mf-artifacts-dry-run', log),
			prose: process.env.ANTHROPIC_API_KEY
				? createLiveProseWriter({ model: workerModel })
				: undefined,
			boot: createDryRunBootCheck(log),
			githubOrg,
			previewAuth,
			dryRun: true,
		}
	}
	return {
		github: githubApp
			? createOctokitGitHubClient(githubApp)
			: {
					createRepo: notConfigured('GITHUB_APP (id/key/installation)'),
					push: notConfigured('GITHUB_APP (id/key/installation)'),
					addCollaborator: notConfigured('GITHUB_APP (id/key/installation)'),
				},
		deploy: (() => {
			const missing = missingExpressSetting({
				ecrRepositoryUri,
				codeBuildProject,
				expressExecutionRoleArn,
				expressInfrastructureRoleArn,
				previewAuth,
			})
			return missing
				? { deployFromRepo: notConfigured(`ECS_EXPRESS (${missing})`) }
				: createEcsExpressDeployClient({
						imageBuilder: createCodeBuildImageBuilder({
							project: codeBuildProject!,
							ecrRepositoryUri: ecrRepositoryUri!,
							region,
						}),
						executionRoleArn: expressExecutionRoleArn!,
						infrastructureRoleArn: expressInfrastructureRoleArn!,
						cluster,
						previewAuth,
						region,
						logGroup: defaultExpressLogGroup(),
					})
		})(),
		artifacts: artifactsBucket
			? createS3ArtifactStore(artifactsBucket, region, artifactsScope)
			: {
					kind: 'none',
					bucket: '',
					urlOf: key => key,
					putObject: notConfigured('ARTIFACTS_BUCKET'),
				},
		prose: createLiveProseWriter({ model: workerModel }),
		// Boots the built server AND replays the built frontend's calls — a route the SPA needs but
		// the backend does not serve (a 404, e.g. a `/bff` prefix the worker skipped) fails here, so
		// a dead-in-browser app never gets deployed even though the gates and a plain boot pass.
		boot: createWiredSmokeCheck(),
		githubOrg,
		previewAuth,
	}
}

/** Everything faked in memory — what the unit tests and the orchestrator test use */
export const createFakeDeliveryClients = (): DeliveryClients => ({
	github: createFakeGitHubClient(),
	deploy: createFakeDeployClient(),
	artifacts: createFakeArtifactStore(),
	prose: createFakeProseWriter(),
	boot: createFakeBootCheck(),
})

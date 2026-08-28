import {
	BatchGetBuildsCommand,
	CodeBuildClient,
	StartBuildCommand,
} from '@aws-sdk/client-codebuild'

import { abortError, defaultSleep } from './polling.ts'

import type { CodeBuildClientLike } from './imageBuildClient.ts'

// MARK: Interface

export type ImageBuildInput = {
	/** Tag for the built image (the job-unique service name); also the CodeBuild `IMAGE_TAG` override */
	imageTag: string
	/** S3 location of this job's repo zip — the per-job CodeBuild source (`sourceLocationOverride`) */
	source: { bucket: string; key: string }
	/** Kill switch / budget — rejects the build instead of polling on */
	signal?: AbortSignal
}

/**
 * Builds the customer container image and pushes it to ECR, returning the pushed image URI.
 * One small interface so the Express deploy client stays testable: the real one drives AWS
 * CodeBuild, the fake returns a deterministic URI without touching AWS.
 */
export type ImageBuilderLike = {
	build: (input: ImageBuildInput) => Promise<{ imageUri: string }>
}

// MARK: Live client (CodeBuild)

export type CodeBuildOptions = {
	/** CodeBuild project name (`mf-delivery-build-<env>`), created in infra with an S3 source */
	project: string
	/** ECR repository URI images are tagged under (`<acct>.dkr.ecr.<region>.amazonaws.com/mf-deliverables-<env>`) */
	ecrRepositoryUri: string
	/** Polling for the build to leave `IN_PROGRESS` (default 20 min, 10 s apart) */
	timeoutMs?: number
	pollIntervalMs?: number
	now?: () => number
	/** Injectable for tests; the default resolves after `ms` or rejects when `signal` aborts */
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
	region?: string
	/** Injectable for tests (default: `CodeBuildClient` from the environment) */
	client?: CodeBuildClientLike
}

/**
 * !!! LIVE-UNVERIFIED — real AWS calls, never exercised by a test. !!!
 *
 * Builds the pushed customer repo into a container image via AWS CodeBuild and pushes it to
 * ECR. The CodeBuild project (infra) is S3-sourced — the delivery uploads the built repo as
 * the source zip, so CodeBuild needs no GitHub credentials — and its buildspec runs
 * `docker build` + `aws ecr get-login-password | docker login` + `docker push`. This client
 * only starts the build (passing the ECR repo + image tag as environment overrides) and polls
 * `BatchGetBuilds` until it reaches a terminal status, honouring `signal`. It returns the
 * `<ecrRepositoryUri>:<imageTag>` the buildspec pushed to. The CodeBuild API is stable and
 * pre-cutoff; this is marked live-unverified only because it is never run in CI.
 *
 * The per-job source is `sourceLocationOverride` (an S3 zip the delivery uploaded via
 * `uploadSource`), so each delivery builds its own repo without any GitHub credentials in CodeBuild.
 */
export const createCodeBuildImageBuilder = ({
	project,
	ecrRepositoryUri,
	timeoutMs = 20 * 60_000,
	pollIntervalMs = 10_000,
	now = Date.now,
	sleep = defaultSleep,
	region,
	client = new CodeBuildClient({ region }),
}: CodeBuildOptions): ImageBuilderLike => {
	const terminal = new Set(['SUCCEEDED', 'FAILED', 'FAULT', 'STOPPED', 'TIMED_OUT'])

	const waitForBuild = async (buildId: string, signal?: AbortSignal) => {
		const deadline = now() + timeoutMs
		for (;;) {
			if (signal?.aborted) throw abortError()
			const { builds } = await client.send(new BatchGetBuildsCommand({ ids: [buildId] }))
			const status = builds?.[0]?.buildStatus
			if (status === 'SUCCEEDED') return
			if (status && terminal.has(status)) {
				throw new Error(`CodeBuild ${buildId} finished ${status}`)
			}
			if (now() >= deadline) throw new Error(`CodeBuild ${buildId} did not finish in time`)
			await sleep(pollIntervalMs, signal)
		}
	}

	return {
		build: async ({ imageTag, source, signal }) => {
			if (signal?.aborted) throw abortError()
			const { build } = await client.send(
				new StartBuildCommand({
					projectName: project,
					// Per-job source: build THIS job's repo zip, not the project's fixed source
					sourceTypeOverride: 'S3',
					sourceLocationOverride: `${source.bucket}/${source.key}`,
					environmentVariablesOverride: [
						{ name: 'ECR_REPOSITORY_URI', value: ecrRepositoryUri },
						{ name: 'IMAGE_TAG', value: imageTag },
					],
				})
			)
			if (!build?.id) throw new Error('CodeBuild StartBuild returned no build id')
			await waitForBuild(build.id, signal)
			return { imageUri: `${ecrRepositoryUri}:${imageTag}` }
		},
	}
}

// MARK: Fake

export type FakeImageBuilder = ImageBuilderLike & {
	/** Every `build` call's image tag, in order — asserted by the tests */
	builds: string[]
	/** Every `build` call's per-job source, in order */
	sources: { bucket: string; key: string }[]
}

/** In-memory image builder for the unit tests: records tags, returns a deterministic URI */
export const createFakeImageBuilder = (
	ecrRepositoryUri = 'acct.dkr.ecr.eu-north-1.amazonaws.com/mf-deliverables-test',
	fail = false
): FakeImageBuilder => {
	const fake: FakeImageBuilder = {
		builds: [],
		sources: [],
		build: async ({ imageTag, source, signal }) => {
			if (signal?.aborted) throw abortError()
			if (fail) throw new Error('fake: image build failed')
			fake.builds.push(imageTag)
			fake.sources.push(source)
			return { imageUri: `${ecrRepositoryUri}:${imageTag}` }
		},
	}
	return fake
}

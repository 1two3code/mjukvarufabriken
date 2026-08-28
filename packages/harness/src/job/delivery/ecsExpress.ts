import {
	CreateExpressGatewayServiceCommand,
	DescribeExpressGatewayServiceCommand,
	ECSClient,
} from '@aws-sdk/client-ecs'

import { abortError, defaultSleep } from './polling.ts'

import type { ECSExpressGatewayService } from '@aws-sdk/client-ecs'
import type { EcsClientLike } from './ecsExpressClient.ts'
import type { ImageBuilderLike } from './imageBuild.ts'
import type { DeployClient, PreviewAuth } from './types.ts'

/**
 * Express service names: up to 255 letters/digits/underscores/hyphens. The job-unique
 * `mf-<job8>-<slug>` already fits; sanitise defensively and never start with a hyphen.
 */
export const expressServiceName = (name: string) =>
	name
		.replace(/[^A-Za-z0-9_-]/g, '-')
		.replace(/^-+/, '')
		.slice(0, 255) || 'mf-app'

/** The api's auth env (the same `previewAuth` the App Runner client wrote into `apprunner.yaml`) */
const previewAuthEnv = (auth?: PreviewAuth) =>
	auth
		? [
				{ name: 'AUTH_ISSUER', value: auth.issuer },
				{ name: 'AUTH_JWKS_URL', value: auth.jwksUrl },
				{ name: 'AUTH_AUDIENCE', value: auth.audience },
			]
		: []

/** The PUBLIC ingress endpoint of the active configuration, once ECS has populated it */
const publicEndpointOf = (service?: ECSExpressGatewayService) =>
	service?.activeConfigurations
		?.flatMap(configuration => configuration.ingressPaths ?? [])
		.find(path => path.accessType === 'PUBLIC')?.endpoint

// MARK: Live client (ECS Express Mode)

export type EcsExpressOptions = {
	/** Builds + pushes the customer image to ECR, returning the image URI to deploy */
	imageBuilder: ImageBuilderLike
	/** `AmazonECSTaskExecutionRolePolicy` role — pulls the ECR image, writes container logs */
	executionRoleArn: string
	/** Role with `AmazonECSInfrastructureRoleforExpressGatewayServices` — provisions the managed ALB */
	infrastructureRoleArn: string
	/** ECS cluster the Express service runs on (default `default`) */
	cluster?: string
	/** Identity provider the preview api verifies tokens against (passed as container env) */
	previewAuth?: PreviewAuth
	/** Port the api container listens on (template api: 80 — apps/api/Dockerfile `PORT=80`) */
	containerPort?: number
	/** CloudWatch log group for the preview container (created in infra) */
	logGroup?: string
	/** Polling for the PUBLIC endpoint to be populated (default 15 min, 10 s apart) */
	timeoutMs?: number
	pollIntervalMs?: number
	now?: () => number
	/** Injectable for tests; the default resolves after `ms` or rejects when `signal` aborts */
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
	region?: string
	/** Injectable for tests (default: `ECSClient` from the environment) */
	client?: EcsClientLike
}

/**
 * !!! LIVE-UNVERIFIED — real AWS calls, never exercised by a test. !!!
 *
 * Deploys the api of the pushed customer repo to Amazon ECS Express Mode. Express takes a
 * prebuilt container image (unlike App Runner, which built from the GitHub repo), so the deploy
 * is two steps: build + push the image to ECR (the injected `imageBuilder`), then
 * `CreateExpressGatewayService` with that image, the execution + infrastructure roles, the api
 * auth env and the `Service=mf-delivery` tag (the IAM fence). ECS returns the service directly;
 * the app URL is `https://<endpoint>` of the PUBLIC `activeConfigurations[].ingressPaths[]`.
 * When the endpoint is not populated yet the client polls `DescribeExpressGatewayService`,
 * stopping as soon as `signal` aborts. One service per job (`mf-<job8>-<slug>`), so a redelivery
 * never collides with or hands out the URL of another job's preview.
 *
 * The `CreateExpressGatewayServiceCommand` API is post-cutoff (verified against the AWS docs
 * 2026-08-28 and the installed `@aws-sdk/client-ecs` types), hence live-unverified: the shapes
 * type-check, but the runtime behaviour against real AWS is confirmed only on the first deploy.
 */
export const createEcsExpressDeployClient = ({
	imageBuilder,
	executionRoleArn,
	infrastructureRoleArn,
	cluster = 'default',
	previewAuth,
	containerPort = 80,
	logGroup,
	timeoutMs = 15 * 60_000,
	pollIntervalMs = 10_000,
	now = Date.now,
	sleep = defaultSleep,
	region,
	client = new ECSClient({ region }),
}: EcsExpressOptions): DeployClient => {
	const describe = async (serviceArn: string) =>
		(await client.send(new DescribeExpressGatewayServiceCommand({ serviceArn }))).service

	const waitForEndpoint = async (service: ECSExpressGatewayService, signal?: AbortSignal) => {
		const ready = publicEndpointOf(service)
		if (ready) return ready
		const serviceArn = service.serviceArn!
		const deadline = now() + timeoutMs
		for (;;) {
			if (signal?.aborted) throw abortError()
			const current = await describe(serviceArn)
			const endpoint = publicEndpointOf(current)
			if (endpoint) return endpoint
			const status = current?.status?.statusCode
			if (status && status !== 'ACTIVE') {
				throw new Error(`ECS Express service ${serviceArn} is ${status}`)
			}
			if (now() >= deadline) {
				throw new Error(`ECS Express service ${serviceArn} exposed no endpoint in time`)
			}
			await sleep(pollIntervalMs, signal)
		}
	}

	return {
		deployFromRepo: async ({ serviceName, signal }) => {
			const name = expressServiceName(serviceName)
			const { imageUri } = await imageBuilder.build({ imageTag: name, signal })
			if (signal?.aborted) throw abortError()
			const { service } = await client.send(
				new CreateExpressGatewayServiceCommand({
					serviceName: name,
					cluster,
					infrastructureRoleArn,
					executionRoleArn,
					healthCheckPath: '/health',
					cpu: '256',
					memory: '512',
					tags: [{ key: 'Service', value: 'mf-delivery' }],
					primaryContainer: {
						image: imageUri,
						containerPort,
						environment: previewAuthEnv(previewAuth),
						...(logGroup
							? { awsLogsConfiguration: { logGroup, logStreamPrefix: name } }
							: {}),
					},
				})
			)
			if (!service?.serviceArn) {
				throw new Error('ECS CreateExpressGatewayService returned no service')
			}
			return { url: `https://${await waitForEndpoint(service, signal)}` }
		},
	}
}

// MARK: Fakes

export type FakeDeploy = DeployClient & {
	deployments: { serviceName: string; repositoryUrl: string; branch: string }[]
}

/** Placeholder preview URL for the fakes/dry-run (cosmetic — the shape ECS Express hands out) */
const fakeUrl = (name: string, region = 'eu-north-1') =>
	`https://${expressServiceName(name)}.${region}.on.aws`

export const createFakeDeployClient = (fail = false): FakeDeploy => {
	const fake: FakeDeploy = {
		deployments: [],
		deployFromRepo: async ({ signal: _signal, ...input }) => {
			if (fail) throw new Error('fake: ECS Express deploy failed')
			fake.deployments.push(input)
			return { url: fakeUrl(input.serviceName) }
		},
	}
	return fake
}

export const createDryRunDeployClient = (log: (line: string) => void): DeployClient => ({
	deployFromRepo: async ({ serviceName, repositoryUrl, branch }) => {
		const name = expressServiceName(serviceName)
		log(`[dry-run] ecs express: build image + create service ${name} from ${repositoryUrl}#${branch}`)
		return { url: fakeUrl(name) }
	},
})

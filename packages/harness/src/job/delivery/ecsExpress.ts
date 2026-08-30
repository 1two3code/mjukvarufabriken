import { createHash } from 'node:crypto'

import {
	CreateExpressGatewayServiceCommand,
	DescribeExpressGatewayServiceCommand,
	ECSClient,
} from '@aws-sdk/client-ecs'

/** The api's auth env (the same `previewAuth` the App Runner client wrote into `apprunner.yaml`) */
import { appSecretsEnv } from './appSecrets.ts'
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

/**
 * The per-customer fence value stamped as `Customer=<slug>` on the Express service and everything
 * delivery provisions. @mf/org `deprovision` REQUIRES this tag: a real (dryRun:false)
 * suspend/teardown is scoped to BOTH `Service=mf-delivery` AND `Customer=<slug>`, so a destructive
 * sweep can never span customers or the whole platform (@mf/org constants CUSTOMER_TAG_KEY).
 *
 * The value is derived from the job-unique service name `mf-<job8>-<slug>` by stripping the
 * `mf-<job8>-` prefix and normalising the remainder to a valid @mf/org slug (lowercase, hyphen
 * separated, 2–40 chars — @mf/org `SlugSchema`, which `deprovision` parses the tag back through).
 * Deriving it here — rather than threading a new field through the delivery orchestrator — keeps
 * the tag a self-contained property of the service the client creates.
 */
export const customerTagValue = (serviceName: string): string => {
	const withoutPrefix = expressServiceName(serviceName).replace(/^mf-[0-9a-f]{1,8}-/i, '')
	const normalised = (withoutPrefix || serviceName)
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-+|-+$/g, '')
	// The delivery slug is `<app-name>-<job8>` (apps/job): the trailing `-<job8>` is the discriminator
	// that makes the `Customer=<slug>` fence JOB-unique. A blind `.slice(0, 40)` on a long app name
	// would truncate that suffix off and two different jobs for the same long-named app would share a
	// fence — a teardown of one could then span the other. So when the value ends in a job discriminator,
	// truncate only the app-name portion and reattach the suffix, staying within the 40-char slug limit.
	const jobId = /^(.*)-([0-9a-f]{8})$/.exec(normalised)
	const slug = jobId
		? `${jobId[1].slice(0, 40 - jobId[2].length - 1).replace(/-+$/g, '')}-${jobId[2]}`
		: normalised.slice(0, 40).replace(/-+$/g, '')
	// @mf/org SlugSchema requires ≥2 chars AND no trailing hyphen; pad a degenerate slug (and strip
	// the trailing hyphen `mf-` would leave) so the fence tag always parses back through SlugSchema.
	return slug.length >= 2 ? slug : `mf-${slug}`.slice(0, 40).replace(/-+$/g, '')
}

/**
 * Whether a value is a usable `Customer=<slug>` fence — the same shape @mf/org SlugSchema accepts
 * and `deprovision` parses the tag back through (2–40 chars, lowercase alphanumeric, internal
 * hyphens, no leading/trailing hyphen). A service tagged with anything else is un-teardownable by a
 * fenced deprovision, so delivery refuses to stand it up (see `deployFromRepo`).
 */
export const isFenceableSlug = (value: string): boolean =>
	value.length >= 2 && value.length <= 40 && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(value)

const previewAuthEnv = (auth?: PreviewAuth) =>
	auth
		? [
				{ name: 'AUTH_ISSUER', value: auth.issuer },
				{ name: 'AUTH_JWKS_URL', value: auth.jwksUrl },
				{ name: 'AUTH_AUDIENCE', value: auth.audience },
			]
		: []

/**
 * The container `environment` list: the auth contract first, then the app's full required runtime
 * env (`env`, from delivery's env manifest — generated secrets + placeholders) overriding it, so an
 * app requiring arbitrary secrets runs live. `env` last wins, and a Map dedupes by name. Without an
 * `env` (older callers / static deliveries) it falls back to the fixed generated app-secret set.
 */
const containerEnvironment = (previewAuth?: PreviewAuth, env?: Record<string, string>) => {
	const appEnv = env
		? Object.entries(env).map(([name, value]) => ({ name, value }))
		: appSecretsEnv()
	const merged = new Map<string, string>()
	for (const { name, value } of [...previewAuthEnv(previewAuth), ...appEnv]) merged.set(name, value)
	return [...merged].map(([name, value]) => ({ name, value }))
}

/** The PUBLIC ingress endpoint of the active configuration, once ECS has populated it */
/** The endpoint may already carry a scheme (real AWS returns `https://…on.aws`); don't double it */
const toHttpsUrl = (endpoint: string) =>
	/^https?:\/\//i.test(endpoint) ? endpoint : `https://${endpoint}`

const publicEndpointOf = (service?: ECSExpressGatewayService) =>
	service?.activeConfigurations
		?.flatMap(configuration => configuration.ingressPaths ?? [])
		.find(path => path.accessType === 'PUBLIC')?.endpoint

/** Default CloudWatch log group for delivered Express containers (per env), so boot crashes are visible */
export const defaultExpressLogGroup = (env = process.env.ENV || 'local') => `/mf/${env}/express`

/**
 * A deterministic idempotency token for the create call, derived from the service name: an SDK
 * retry after a successful `CreateExpressGatewayService` re-sends the same token, so ECS returns
 * the original service instead of throwing "Creation of service was not idempotent" (which used
 * to make delivery report `deploy: failed` for a service that was actually live). Length-capped
 * to 64 ASCII chars — a service name can be up to 255, so a hash, not the name itself.
 */
export const createIdempotencyToken = (serviceName: string) =>
	`mf-${createHash('sha256').update(serviceName).digest('hex').slice(0, 60)}`

/**
 * The create call is a no-op when the service already exists (a prior create, or an SDK retry
 * the deterministic clientToken did not dedupe): ECS answers with a "not idempotent" / "already
 * exists" / "not found" error. That is not a delivery failure — the service is live — so describe
 * it and hand out its URL instead of throwing.
 */
const isAlreadyCreated = (error: unknown) =>
	/not idempotent|already exists|already created|not found/i.test((error as Error).message ?? '')

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
	logGroup = defaultExpressLogGroup(),
	timeoutMs = 15 * 60_000,
	pollIntervalMs = 10_000,
	now = Date.now,
	sleep = defaultSleep,
	region,
	client = new ECSClient({ region }),
}: EcsExpressOptions): DeployClient => {
	// `serviceIdentifier` is the ARN when we have it (after Create) and the deterministic name
	// otherwise (the idempotency fallback, where Create threw before handing back an ARN)
	const account = executionRoleArn.split(':')[4] ?? ''
	// Build the full service ARN (the API describes by ARN, not by bare name) for the idempotency
	// fallback below.
	const serviceArnOf = (svc: string) =>
		`arn:aws:ecs:${region ?? ''}:${account}:service/${cluster}/${svc}`
	const describe = async (serviceIdentifier: string) =>
		(await client.send(new DescribeExpressGatewayServiceCommand({ serviceArn: serviceIdentifier })))
			.service

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

	/**
	 * Creates the service, or — when ECS reports it already exists (an SDK retry the clientToken
	 * did not dedupe, a redelivery) — describes it and returns the live one instead of failing the
	 * whole deploy. Describing by the deterministic service name; the endpoint poll follows either way.
	 */
	const createOrDescribe = async (
		createInput: ConstructorParameters<typeof CreateExpressGatewayServiceCommand>[0] & {
			clientToken?: string
		},
		name: string
	) => {
		try {
			return (await client.send(new CreateExpressGatewayServiceCommand(createInput))).service
		} catch (error) {
			if (!isAlreadyCreated(error)) throw error
			const existing = await describe(serviceArnOf(name)).catch(() => undefined)
			if (existing?.serviceArn) return existing
			throw error
		}
	}

	return {
		deployFromRepo: async ({ serviceName, source, env, signal }) => {
			const name = expressServiceName(serviceName)
			// Fail closed BEFORE building/standing anything up: a service that cannot carry a valid
			// `Customer=<slug>` fence is un-teardownable by a fenced deprovision (an orphan on the
			// account, seen with mf-familyhub). No unfenceable service is ever delivered.
			const customerTag = customerTagValue(name)
			if (!isFenceableSlug(customerTag)) {
				throw new Error(
					`delivery: refusing to deploy '${name}' — its Customer fence tag ` +
						`'${customerTag}' is not a valid deprovision slug; the service would be un-teardownable`
				)
			}
			const { imageUri } = await imageBuilder.build({ imageTag: name, source, signal })
			if (signal?.aborted) throw abortError()
			// `clientToken` is not yet in the installed SDK's request type (post-cutoff API), but the
			// deterministic token is what makes the create idempotent — so it is passed regardless.
			const createInput = {
				serviceName: name,
				cluster,
				infrastructureRoleArn,
				executionRoleArn,
				healthCheckPath: '/health',
				cpu: '256',
				memory: '512',
				clientToken: createIdempotencyToken(name),
				// `Service=mf-delivery` is the discovery fence; `Customer=<slug>` is the per-customer
				// fence @mf/org deprovision REQUIRES to scope a real suspend/teardown to one customer.
				tags: [
					{ key: 'Service', value: 'mf-delivery' },
					{ key: 'Customer', value: customerTag },
				],
				primaryContainer: {
					image: imageUri,
					containerPort,
					environment: containerEnvironment(previewAuth, env),
					// Always wire the log group so a boot crash lands in CloudWatch, not just an exit code
					awsLogsConfiguration: { logGroup, logStreamPrefix: name },
				},
			}
			const service = await createOrDescribe(createInput, name)
			if (!service?.serviceArn) {
				throw new Error('ECS CreateExpressGatewayService returned no service')
			}
			const url = toHttpsUrl(await waitForEndpoint(service, signal))
			// Report the service so the api can record it per order: teardown targets EVERY recorded
			// service and resume replays `config` (the create input, minus the transient clientToken)
			// to re-stand-up a suspended (deleted) one with the same image/roles/port/env.
			const { clientToken: _clientToken, ...config } = createInput
			return {
				url,
				service: {
					serviceName: name,
					serviceArn: service.serviceArn,
					customerTag,
					image: imageUri,
					config,
				},
			}
		},
	}
}

// MARK: Fakes

export type FakeDeploy = DeployClient & {
	deployments: {
		serviceName: string
		repositoryUrl: string
		branch: string
		source: { bucket: string; key: string }
	}[]
	/** The runtime env passed alongside each deployment (the app's required set), parallel to `deployments` */
	envs: (Record<string, string> | undefined)[]
}

/** Placeholder preview URL for the fakes/dry-run (cosmetic — the shape ECS Express hands out) */
const fakeUrl = (name: string, region = 'eu-north-1') =>
	`https://${expressServiceName(name)}.${region}.on.aws`

/** A minimal, valid service report for the fakes — enough for the api's per-order recording */
const fakeServiceReport = (
	serviceName: string,
	env?: Record<string, string>
): NonNullable<Awaited<ReturnType<DeployClient['deployFromRepo']>>['service']> => {
	const name = expressServiceName(serviceName)
	return {
		serviceName: name,
		serviceArn: `arn:aws:ecs:eu-north-1:000000000000:service/default/${name}`,
		customerTag: customerTagValue(name),
		image: `000000000000.dkr.ecr.eu-north-1.amazonaws.com/mf-deliverables:${name}`,
		config: {
			serviceName: name,
			cluster: 'default',
			primaryContainer: {
				image: `000000000000.dkr.ecr.eu-north-1.amazonaws.com/mf-deliverables:${name}`,
				containerPort: 80,
				environment: Object.entries(env ?? {}).map(([envName, value]) => ({ name: envName, value })),
			},
		},
	}
}

export const createFakeDeployClient = (fail = false): FakeDeploy => {
	const fake: FakeDeploy = {
		deployments: [],
		envs: [],
		// `env` is recorded separately so `deployments` keeps its stable four-key shape for assertions
		deployFromRepo: async ({ signal: _signal, env, ...input }) => {
			if (fail) throw new Error('fake: ECS Express deploy failed')
			fake.deployments.push(input)
			fake.envs.push(env)
			return { url: fakeUrl(input.serviceName), service: fakeServiceReport(input.serviceName, env) }
		},
	}
	return fake
}

export const createDryRunDeployClient = (log: (line: string) => void): DeployClient => ({
	deployFromRepo: async ({ serviceName, repositoryUrl, branch }) => {
		const name = expressServiceName(serviceName)
		log(
			`[dry-run] ecs express: build image + create service ${name} from ${repositoryUrl}#${branch}`
		)
		// No `service`: a dry-run creates nothing, so there is nothing to record
		return { url: fakeUrl(name) }
	},
})

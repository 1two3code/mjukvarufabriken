import {
	CreateExpressGatewayServiceCommand,
	DescribeExpressGatewayServiceCommand,
} from '@aws-sdk/client-ecs'

import { createEcsExpressDeployClient, customerTagValue } from '#job/delivery/ecsExpress.ts'
import { createFakeImageBuilder } from '#job/delivery/imageBuild.ts'
import { previewServiceName } from '#job/delivery/deliver.ts'

import type { EcsClientLike } from '#job/delivery/ecsExpressClient.ts'

// MARK: Fixtures

type Sent = { name: string; input: Record<string, unknown> }

/** A service payload with (or without) a PUBLIC ingress endpoint */
const service = (endpoint?: string, statusCode = 'ACTIVE') => ({
	serviceArn: 'arn:svc',
	status: { statusCode },
	activeConfigurations: [
		{ ingressPaths: endpoint ? [{ accessType: 'PUBLIC', endpoint }] : [] },
	],
})

/**
 * Records every command. `createEndpoint` is the endpoint on the Create response (undefined →
 * not populated yet); `describeEndpoints` the sequence Describe answers with.
 */
const createStub = ({
	createEndpoint,
	describeEndpoints = ['svc.eu-north-1.on.aws'],
	describeStatus = 'ACTIVE',
}: {
	createEndpoint?: string
	describeEndpoints?: (string | undefined)[]
	describeStatus?: string
} = {}) => {
	const sent: Sent[] = []
	let describes = 0
	const send = async (command: { constructor: unknown; input: Record<string, unknown> }) => {
		sent.push({ name: (command.constructor as { name: string }).name, input: command.input })
		if (command instanceof CreateExpressGatewayServiceCommand) {
			return { service: service(createEndpoint) }
		}
		if (command instanceof DescribeExpressGatewayServiceCommand) {
			const endpoint = describeEndpoints[Math.min(describes, describeEndpoints.length - 1)]
			describes += 1
			return { service: service(endpoint, describeStatus) }
		}
		throw new Error('unexpected command')
	}
	const client = { send } as unknown as EcsClientLike
	return { client, sent }
}

const names = (sent: Sent[]) => sent.map(entry => entry.name)

const deployClient = (client: EcsClientLike, overrides = {}) =>
	createEcsExpressDeployClient({
		imageBuilder: createFakeImageBuilder(),
		executionRoleArn: 'arn:exec',
		infrastructureRoleArn: 'arn:infra',
		previewAuth: {
			issuer: 'https://api.mjukvaruhuset.se',
			jwksUrl: 'https://api.mjukvaruhuset.se/.well-known/jwks.json',
			audience: 'preview',
		},
		logGroup: '/mf/dev/express',
		client,
		...overrides,
	})

// MARK: Tests

describe('ECS Express deploy client', () => {
	it('Builds the image, creates a tagged service and returns the PUBLIC endpoint URL', async () => {
		// Arrange
		const { client, sent } = createStub({ createEndpoint: 'svc.eu-north-1.on.aws' })
		const imageBuilder = createFakeImageBuilder()
		const deploy = deployClient(client, { imageBuilder })

		// Act
		const { url } = await deploy.deployFromRepo({
			serviceName: 'mf-11111111-gym',
			repositoryUrl: 'https://github.com/x/new',
			branch: 'main',
			source: { bucket: 'mf-artifacts-test', key: 'deliverables/11111111/source.zip' },
		})

		// Assert — image built first (tag = service name), then a single Create, no Describe needed
		expect(url).toBe('https://svc.eu-north-1.on.aws')
		expect(imageBuilder.builds).toEqual(['mf-11111111-gym'])
		expect(imageBuilder.sources).toEqual([
			{ bucket: 'mf-artifacts-test', key: 'deliverables/11111111/source.zip' },
		])
		expect(names(sent)).toEqual(['CreateExpressGatewayServiceCommand'])
		expect(sent[0]!.input).toMatchObject({
			serviceName: 'mf-11111111-gym',
			tags: [
				{ key: 'Service', value: 'mf-delivery' },
				{ key: 'Customer', value: 'gym' },
			],
			primaryContainer: {
				image: expect.stringContaining(':mf-11111111-gym'),
				containerPort: 80,
				environment: expect.arrayContaining([
					{ name: 'AUTH_ISSUER', value: 'https://api.mjukvaruhuset.se' },
				]),
			},
		})
	})

	it('Does not double the scheme when AWS returns an endpoint that already has https://', async () => {
		const { client } = createStub({ createEndpoint: 'https://mf-abc.ecs.eu-north-1.on.aws' })
		const deploy = deployClient(client, { imageBuilder: createFakeImageBuilder() })
		const { url } = await deploy.deployFromRepo({
			serviceName: 'mf-11111111-gym',
			repositoryUrl: 'https://github.com/x/new',
			branch: 'main',
			source: { bucket: 'mf-artifacts-test', key: 'deliverables/11111111/source.zip' },
		})
		expect(url).toBe('https://mf-abc.ecs.eu-north-1.on.aws')
	})

	it('Polls DescribeExpressGatewayService until the endpoint is populated', async () => {
		// Arrange — Create returns no endpoint yet; the second Describe has it
		const { client, sent } = createStub({
			createEndpoint: undefined,
			describeEndpoints: [undefined, 'later.eu-north-1.on.aws'],
		})
		const sleep = vi.fn(async () => {})
		const deploy = deployClient(client, { sleep })

		// Act
		const { url } = await deploy.deployFromRepo({
			serviceName: 'mf-11111111-gym',
			repositoryUrl: 'https://github.com/x/new',
			branch: 'main',
			source: { bucket: 'mf-artifacts-test', key: 'deliverables/11111111/source.zip' },
		})

		// Assert
		expect(url).toBe('https://later.eu-north-1.on.aws')
		expect(names(sent)).toEqual([
			'CreateExpressGatewayServiceCommand',
			'DescribeExpressGatewayServiceCommand',
			'DescribeExpressGatewayServiceCommand',
		])
		expect(sleep).toHaveBeenCalledTimes(1)
	})

	it('Injects the app-required env (manifest) into the container, auth contract included', async () => {
		// Arrange
		const { client, sent } = createStub({ createEndpoint: 'svc.eu-north-1.on.aws' })
		const deploy = deployClient(client, { imageBuilder: createFakeImageBuilder() })

		// Act — delivery passes the full required set (generated secrets + a placeholder)
		await deploy.deployFromRepo({
			serviceName: 'mf-11111111-gym',
			repositoryUrl: 'https://github.com/x/new',
			branch: 'main',
			source: { bucket: 'mf-artifacts-test', key: 'deliverables/11111111/source.zip' },
			env: {
				AUTH_JWT_SECRET: 'generated-jwt',
				APP_SIGNING_SECRET: 'generated-signing',
				STRIPE_SECRET_KEY: 'TODO_SET_BY_OPERATOR_STRIPE_SECRET_KEY',
			},
		})

		// Assert — every manifest var reached the container, plus the auth contract, no dupes
		const environment = (
			sent[0]!.input.primaryContainer as { environment: { name: string; value: string }[] }
		).environment
		expect(environment).toEqual(
			expect.arrayContaining([
				{ name: 'AUTH_ISSUER', value: 'https://api.mjukvaruhuset.se' },
				{ name: 'AUTH_JWT_SECRET', value: 'generated-jwt' },
				{ name: 'APP_SIGNING_SECRET', value: 'generated-signing' },
				{ name: 'STRIPE_SECRET_KEY', value: 'TODO_SET_BY_OPERATOR_STRIPE_SECRET_KEY' },
			])
		)
		const names_ = environment.map(entry => entry.name)
		expect(new Set(names_).size).toBe(names_.length)
	})

	it('Falls back to the generated app secrets when no env is passed (older callers)', async () => {
		const { client, sent } = createStub({ createEndpoint: 'svc.eu-north-1.on.aws' })
		const deploy = deployClient(client, { imageBuilder: createFakeImageBuilder() })
		await deploy.deployFromRepo({
			serviceName: 'mf-11111111-gym',
			repositoryUrl: 'https://github.com/x/new',
			branch: 'main',
			source: { bucket: 'mf-artifacts-test', key: 'deliverables/11111111/source.zip' },
		})
		const environment = (
			sent[0]!.input.primaryContainer as { environment: { name: string; value: string }[] }
		).environment
		const names_ = environment.map(entry => entry.name)
		expect(names_).toEqual(
			expect.arrayContaining(['AUTH_ISSUER', 'AUTH_JWT_SECRET', 'VAPID_PUBLIC_KEY', 'VAPID_SUBJECT'])
		)
	})

	it('Fails the deploy when the image build fails — no service is created', async () => {
		// Arrange
		const { client, sent } = createStub()
		const deploy = deployClient(client, { imageBuilder: createFakeImageBuilder(undefined, true) })

		// Act + Assert
		await expect(
			deploy.deployFromRepo({
				serviceName: 'mf-11111111-gym',
				repositoryUrl: 'https://github.com/x/new',
				branch: 'main',
				source: { bucket: 'mf-artifacts-test', key: 'deliverables/11111111/source.zip' },
			})
		).rejects.toThrow('fake: image build failed')
		expect(sent).toEqual([])
	})

	it('Fails when the service drains before exposing an endpoint', async () => {
		// Arrange
		const { client } = createStub({
			createEndpoint: undefined,
			describeEndpoints: [undefined],
			describeStatus: 'INACTIVE',
		})
		const deploy = deployClient(client, { sleep: async () => {} })

		// Act + Assert
		await expect(
			deploy.deployFromRepo({
				serviceName: 'mf-11111111-gym',
				repositoryUrl: 'https://github.com/x/new',
				branch: 'main',
				source: { bucket: 'mf-artifacts-test', key: 'deliverables/11111111/source.zip' },
			})
		).rejects.toThrow('is INACTIVE')
	})

	it('Stops polling as soon as the signal aborts', async () => {
		// Arrange
		const { client, sent } = createStub({ createEndpoint: undefined, describeEndpoints: [undefined] })
		const controller = new AbortController()
		const deploy = deployClient(client, { pollIntervalMs: 60_000 })

		// Act
		const pending = deploy.deployFromRepo({
			serviceName: 'mf-11111111-gym',
			repositoryUrl: 'https://github.com/x/new',
			branch: 'main',
			source: { bucket: 'mf-artifacts-test', key: 'deliverables/11111111/source.zip' },
			signal: controller.signal,
		})
		await vi.waitFor(() => expect(names(sent)).toContain('DescribeExpressGatewayServiceCommand'))
		controller.abort()

		// Assert
		await expect(pending).rejects.toThrow('aborted')
		expect(names(sent).filter(name => name === 'DescribeExpressGatewayServiceCommand')).toHaveLength(1)
	})

	it('Passes a deterministic idempotency clientToken and always wires the container log group', async () => {
		// Arrange
		const { client, sent } = createStub({ createEndpoint: 'svc.eu-north-1.on.aws' })
		const deploy = deployClient(client, { imageBuilder: createFakeImageBuilder() })
		const input = {
			serviceName: 'mf-11111111-gym',
			repositoryUrl: 'https://github.com/x/new',
			branch: 'main',
			source: { bucket: 'mf-artifacts-test', key: 'deliverables/11111111/source.zip' },
		}

		// Act — deploy twice; the token is derived from the (identical) service name
		await deploy.deployFromRepo(input)
		await deploy.deployFromRepo(input)

		// Assert — a non-empty clientToken, identical across the two calls, and the log group wired
		const create = sent.filter(entry => entry.name === 'CreateExpressGatewayServiceCommand')
		const token = create[0]!.input.clientToken as string
		expect(token).toMatch(/^mf-[0-9a-f]{60}$/)
		expect(create[1]!.input.clientToken).toBe(token)
		expect(create[0]!.input.primaryContainer).toMatchObject({
			awsLogsConfiguration: { logGroup: '/mf/dev/express', logStreamPrefix: 'mf-11111111-gym' },
		})
	})

	it('Wires a default log group when the caller passes none', async () => {
		// Arrange — no `logGroup` option at all
		const { client, sent } = createStub({ createEndpoint: 'svc.eu-north-1.on.aws' })
		const deploy = createEcsExpressDeployClient({
			imageBuilder: createFakeImageBuilder(),
			executionRoleArn: 'arn:exec',
			infrastructureRoleArn: 'arn:infra',
			client,
		})

		// Act
		await deploy.deployFromRepo({
			serviceName: 'mf-11111111-gym',
			repositoryUrl: 'https://github.com/x/new',
			branch: 'main',
			source: { bucket: 'mf-artifacts-test', key: 'deliverables/11111111/source.zip' },
		})

		// Assert — awsLogsConfiguration is present regardless (boot crashes must be visible)
		const container = sent[0]!.input.primaryContainer as { awsLogsConfiguration?: { logGroup: string } }
		expect(container.awsLogsConfiguration?.logGroup).toBe('/mf/local/express')
	})

	it('Returns the already-live service on a non-idempotent create error (describe fallback)', async () => {
		// Arrange — Create throws the SDK-retry idempotency error; Describe finds the live service
		const sent: Sent[] = []
		const send = async (command: { constructor: unknown; input: Record<string, unknown> }) => {
			sent.push({ name: (command.constructor as { name: string }).name, input: command.input })
			if (command instanceof CreateExpressGatewayServiceCommand) {
				throw new Error('Creation of service was not idempotent')
			}
			if (command instanceof DescribeExpressGatewayServiceCommand) {
				return { service: service('svc.eu-north-1.on.aws') }
			}
			throw new Error('unexpected command')
		}
		const deploy = deployClient({ send } as unknown as EcsClientLike)

		// Act — must not throw: the service is live, delivery just has to hand out its URL
		const { url } = await deploy.deployFromRepo({
			serviceName: 'mf-11111111-gym',
			repositoryUrl: 'https://github.com/x/new',
			branch: 'main',
			source: { bucket: 'mf-artifacts-test', key: 'deliverables/11111111/source.zip' },
		})

		// Assert — Create failed, Describe (by the constructed service ARN) recovered the URL
		expect(url).toBe('https://svc.eu-north-1.on.aws')
		expect(names(sent)).toEqual([
			'CreateExpressGatewayServiceCommand',
			'DescribeExpressGatewayServiceCommand',
		])
		expect(sent[1]!.input).toMatchObject({ serviceArn: expect.stringContaining('service/default/mf-11111111-gym') })
	})

	it('Rethrows a create error that is not an already-exists / idempotency error', async () => {
		// Arrange
		const sent: Sent[] = []
		const send = async (command: { constructor: unknown; input: Record<string, unknown> }) => {
			sent.push({ name: (command.constructor as { name: string }).name, input: command.input })
			if (command instanceof CreateExpressGatewayServiceCommand) {
				throw new Error('AccessDenied: not authorized to create')
			}
			throw new Error('unexpected command')
		}
		const deploy = deployClient({ send } as unknown as EcsClientLike)

		// Act + Assert — a real error is not swallowed, and no Describe fallback is attempted
		await expect(
			deploy.deployFromRepo({
				serviceName: 'mf-11111111-gym',
				repositoryUrl: 'https://github.com/x/new',
				branch: 'main',
				source: { bucket: 'mf-artifacts-test', key: 'deliverables/11111111/source.zip' },
			})
		).rejects.toThrow('AccessDenied')
		expect(names(sent)).toEqual(['CreateExpressGatewayServiceCommand'])
	})

	it('Stamps the per-customer Customer=<slug> fence tag @mf/org deprovision requires', async () => {
		// Arrange
		const { client, sent } = createStub({ createEndpoint: 'svc.eu-north-1.on.aws' })
		const deploy = deployClient(client, { imageBuilder: createFakeImageBuilder() })

		// Act — a long app slug (the real `mf-<job8>-<appslug>-<job8>` shape)
		await deploy.deployFromRepo({
			serviceName: 'mf-11111111-acme-gym-booking-11111111',
			repositoryUrl: 'https://github.com/x/new',
			branch: 'main',
			source: { bucket: 'mf-artifacts-test', key: 'deliverables/11111111/source.zip' },
		})

		// Assert — Service fence + a Customer fence that is a valid @mf/org slug (≤40, lowercased)
		const tags = sent[0]!.input.tags as { key: string; value: string }[]
		const customer = tags.find(tag => tag.key === 'Customer')!
		expect(tags).toContainEqual({ key: 'Service', value: 'mf-delivery' })
		expect(customer.value).toBe('acme-gym-booking-11111111')
		expect(customer.value.length).toBeLessThanOrEqual(40)
		expect(customer.value).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/)
	})

	it('Derives a valid @mf/org slug from the service name (customerTagValue)', () => {
		// Strips the `mf-<job8>-` prefix
		expect(customerTagValue('mf-11111111-gym')).toBe('gym')
		// Lower-cases, collapses illegal characters, trims hyphens
		expect(customerTagValue('mf-abcdef12-My_App!!')).toBe('my-app')
		// Caps to 40 chars with no trailing hyphen
		const long = customerTagValue(`mf-11111111-${'a'.repeat(60)}`)
		expect(long.length).toBe(40)
		expect(long.endsWith('-')).toBe(false)
	})

	it('Keeps the job-unique part of the service name (no collision between jobs)', () => {
		// Arrange
		const slug = 'a-very-long-application-name-from-the-spec-goal-11111111'

		// Act
		const a = previewServiceName('11111111-2222-3333-4444-555555555555', slug)
		const b = previewServiceName('22222222-2222-3333-4444-555555555555', slug)

		// Assert
		expect(a.startsWith('mf-11111111-')).toBe(true)
		expect(a).not.toBe(b)
	})
})

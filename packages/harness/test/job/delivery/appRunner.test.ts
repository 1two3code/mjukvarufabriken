import {
	CreateServiceCommand,
	DescribeServiceCommand,
	ListServicesCommand,
	StartDeploymentCommand,
} from '@aws-sdk/client-apprunner'

import { createAppRunnerDeployClient } from '#job/delivery/appRunner.ts'
import { previewServiceName } from '#job/delivery/deliver.ts'

import type { AppRunnerClientLike } from '#job/delivery/appRunnerClient.ts'

// MARK: Fixtures

type Sent = { name: string; input: Record<string, unknown> }
type Service = { name: string; arn: string; repositoryUrl: string }

/** Records every command; `services` is what List/Describe answer, `statuses` the Describe sequence */
const createStub = ({
	services = [],
	statuses = ['RUNNING'],
}: { services?: Service[]; statuses?: string[] } = {}) => {
	const sent: Sent[] = []
	let describes = 0
	const send = async (command: { constructor: unknown; input: Record<string, unknown> }) => {
		sent.push({ name: (command.constructor as { name: string }).name, input: command.input })
		if (command instanceof ListServicesCommand) {
			return {
				ServiceSummaryList: services.map(s => ({ ServiceName: s.name, ServiceArn: s.arn })),
			}
		}
		if (command instanceof DescribeServiceCommand) {
			const service = services.find(s => s.arn === command.input.ServiceArn)
			const status = statuses[Math.min(describes, statuses.length - 1)]
			describes += 1
			return {
				Service: {
					ServiceArn: command.input.ServiceArn,
					ServiceUrl: 'svc.eu-north-1.awsapprunner.com',
					Status: status,
					SourceConfiguration: {
						CodeRepository: { RepositoryUrl: service?.repositoryUrl },
					},
				},
			}
		}
		if (command instanceof CreateServiceCommand) {
			services.push({
				name: command.input.ServiceName as string,
				arn: 'arn:new',
				repositoryUrl: 'https://github.com/x/new',
			})
			return { Service: { ServiceArn: 'arn:new' } }
		}
		if (command instanceof StartDeploymentCommand) return {}
		throw new Error('unexpected command')
	}
	const client = { send } as unknown as AppRunnerClientLike
	return { client, sent }
}

const names = (sent: Sent[]) => sent.map(s => s.name)

// MARK: Tests

describe('App Runner deploy client', () => {
	it('Creates a tagged service from the repo and resolves its URL once RUNNING', async () => {
		// Arrange
		const { client, sent } = createStub({ statuses: ['OPERATION_IN_PROGRESS', 'RUNNING'] })
		const sleep = vi.fn(async () => {})
		const deploy = createAppRunnerDeployClient({ connectionArn: 'arn:conn', client, sleep })

		// Act
		const { url } = await deploy.deployFromRepo({
			serviceName: 'mf-11111111-gym',
			repositoryUrl: 'https://github.com/x/new',
			branch: 'main',
		})

		// Assert
		expect(url).toBe('https://svc.eu-north-1.awsapprunner.com')
		expect(names(sent)).toEqual([
			'ListServicesCommand',
			'CreateServiceCommand',
			'DescribeServiceCommand',
			'DescribeServiceCommand',
		])
		expect(sent[1]!.input).toMatchObject({
			ServiceName: 'mf-11111111-gym',
			Tags: [{ Key: 'Service', Value: 'mf-delivery' }],
		})
		expect(sleep).toHaveBeenCalledTimes(1)
	})

	it('Redeploys an existing service only when it deploys the same repository', async () => {
		// Arrange
		const existing = { name: 'mf-11111111-gym', arn: 'arn:a', repositoryUrl: 'https://github.com/x/a' }
		const { client, sent } = createStub({ services: [existing] })
		const deploy = createAppRunnerDeployClient({ connectionArn: 'arn:conn', client })

		// Act
		const same = await deploy.deployFromRepo({
			serviceName: existing.name,
			repositoryUrl: 'https://github.com/x/a',
			branch: 'main',
		})
		const other = deploy.deployFromRepo({
			serviceName: existing.name,
			repositoryUrl: 'https://github.com/x/b',
			branch: 'main',
		})

		// Assert — never StartDeployment on (or the URL of) another repo's service
		expect(same.url).toBe('https://svc.eu-north-1.awsapprunner.com')
		await expect(other).rejects.toThrow(
			'App Runner service mf-11111111-gym already exists for https://github.com/x/a, not https://github.com/x/b'
		)
		expect(names(sent).filter(n => n === 'StartDeploymentCommand')).toHaveLength(1)
		expect(names(sent).filter(n => n === 'CreateServiceCommand')).toHaveLength(0)
	})

	it('Stops polling as soon as the signal aborts', async () => {
		// Arrange
		const { client, sent } = createStub({ statuses: ['OPERATION_IN_PROGRESS'] })
		const controller = new AbortController()
		const deploy = createAppRunnerDeployClient({
			connectionArn: 'arn:conn',
			client,
			pollIntervalMs: 60_000,
		})

		// Act
		const pending = deploy.deployFromRepo({
			serviceName: 'mf-11111111-gym',
			repositoryUrl: 'https://github.com/x/new',
			branch: 'main',
			signal: controller.signal,
		})
		await vi.waitFor(() => expect(names(sent)).toContain('DescribeServiceCommand'))
		controller.abort()

		// Assert — rejects at once instead of after the 60 s poll / 15 min deadline
		await expect(pending).rejects.toThrow('aborted')
		expect(names(sent).filter(n => n === 'DescribeServiceCommand')).toHaveLength(1)
	})

	it('Keeps the job-unique part of the service name inside the 40-char limit', () => {
		// Arrange — a long app-name slug, as `appNameOf` produces for most goals
		const slug = 'a-very-long-application-name-from-the-spec-goal-11111111'

		// Act
		const a = previewServiceName('11111111-2222-3333-4444-555555555555', slug)
		const b = previewServiceName('22222222-2222-3333-4444-555555555555', slug)

		// Assert
		expect(a.startsWith('mf-11111111-')).toBe(true)
		expect(a.slice(0, 40)).not.toBe(b.slice(0, 40))
	})
})

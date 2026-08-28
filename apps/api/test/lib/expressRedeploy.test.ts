import { CreateExpressGatewayServiceCommand } from '@aws-sdk/client-ecs'

import { redeployClientToken, redeployExpressServices } from '#/lib/expressRedeploy.ts'

import type { EcsClientLike, RedeployInput } from '#/lib/expressRedeploy.ts'

// MARK: Fixtures

const service = (overrides: Partial<RedeployInput> = {}): RedeployInput => ({
	id: 'row-1',
	serviceName: 'mf-11111111-app',
	config: {
		serviceName: 'mf-11111111-app',
		cluster: 'default',
		primaryContainer: { image: 'ecr/mf-deliverables:mf-11111111-app', containerPort: 80 },
	},
	...overrides,
})

/** Records every command; `send` is driven by the supplied handler. */
const createStub = (
	handler: (command: { constructor: unknown; input: Record<string, unknown> }) => unknown
) => {
	const sent: { name: string; input: Record<string, unknown> }[] = []
	const send = async (command: { constructor: unknown; input: Record<string, unknown> }) => {
		sent.push({ name: (command.constructor as { name: string }).name, input: command.input })
		return handler(command)
	}
	return { client: { send } as unknown as EcsClientLike, sent }
}

// MARK: Tests

describe('redeployExpressServices', () => {
	it('Re-creates each service from its recorded config and returns the new arn', async () => {
		const { client, sent } = createStub(() => ({
			service: { serviceArn: 'arn:aws:ecs:eu-north-1:0:service/default/mf-11111111-app-new' },
		}))

		const result = await redeployExpressServices([service()], { client, dryRun: false })

		expect(result.mode).toBe('resume')
		expect(result.summary.resumed).toBe(1)
		expect(result.items[0]).toMatchObject({
			id: 'row-1',
			outcome: 'resumed',
			serviceArn: 'arn:aws:ecs:eu-north-1:0:service/default/mf-11111111-app-new',
		})
		// Replays the recorded create input, with a deterministic idempotency clientToken
		expect(sent).toHaveLength(1)
		expect(sent[0]!.name).toBe('CreateExpressGatewayServiceCommand')
		expect(sent[0]!.input).toMatchObject({
			serviceName: 'mf-11111111-app',
			clientToken: redeployClientToken('mf-11111111-app'),
			primaryContainer: { image: 'ecr/mf-deliverables:mf-11111111-app' },
		})
	})

	it('Touches nothing on a dry-run — every service is planned', async () => {
		const { client, sent } = createStub(() => {
			throw new Error('should not be called on a dry-run')
		})

		const result = await redeployExpressServices([service(), service({ id: 'row-2' })], {
			client,
			dryRun: true,
		})

		expect(sent).toEqual([])
		expect(result.summary.planned).toBe(2)
		expect(result.items.every(item => item.outcome === 'planned')).toBe(true)
	})

	it('Treats an already-up service (idempotency error) as resumed, not a failure', async () => {
		const { client } = createStub(command => {
			if (command instanceof CreateExpressGatewayServiceCommand) {
				throw new Error('Creation of service was not idempotent')
			}
			throw new Error('unexpected')
		})

		const result = await redeployExpressServices([service()], { client, dryRun: false })

		expect(result.summary.resumed).toBe(1)
		expect(result.summary.failed).toBe(0)
		expect(result.items[0]!.outcome).toBe('resumed')
	})

	it('Records a genuine create error as failed (the lifecycle then holds)', async () => {
		const { client } = createStub(() => {
			throw new Error('AccessDenied: not authorized')
		})

		const result = await redeployExpressServices([service()], { client, dryRun: false })

		expect(result.summary.failed).toBe(1)
		expect(result.items[0]).toMatchObject({ outcome: 'failed', reason: expect.stringMatching(/AccessDenied/) })
	})

	it('Fails a service with no recorded config rather than reporting a false success', async () => {
		const { client, sent } = createStub(() => ({ service: { serviceArn: 'arn:x' } }))

		const result = await redeployExpressServices([service({ config: null })], {
			client,
			dryRun: false,
		})

		expect(sent).toEqual([])
		expect(result.summary.failed).toBe(1)
		expect(result.items[0]!.reason).toMatch(/no recorded config/)
	})
})

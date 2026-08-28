import { createFakeWorld } from '#/actuator.ts'
import { deprovision } from '#/deprovision.ts'

import type { ResourceActuator } from '#/actuator.ts'
import type { Discover } from '#/discover.ts'
import type { DeliveryResource } from '#/schemas.ts'

const TAG = { Service: 'mf-delivery' }

const ECS = 'arn:aws:ecs:eu-north-1:111:service/mf/acme'
const ECR = 'arn:aws:ecr:eu-north-1:111:repository/mf-acme'
const S3 = 'arn:aws:s3:::mf-acme-deliverables'

const fixedNow = () => Date.parse('2026-08-28T10:00:00.000Z')

/** A discover that just replays a fixed list (what the tagging API would have returned). */
const discoverOf =
	(resources: DeliveryResource[]): Discover =>
	async () =>
		resources

describe('deprovision', () => {
	it('Is dry-run by default: plans every resource, touches nothing', async () => {
		const world = createFakeWorld([
			{ arn: ECS, service: 'ecs' },
			{ arn: S3, service: 's3' },
		])

		const result = await deprovision({ label: 'acme' }, 'teardown', {
			discover: () => world.discover(),
			actuator: world.actuator,
			now: fixedNow,
		})

		expect(result.dryRun).toBe(true)
		expect(result.summary.planned).toBe(2)
		expect(result.entries.every(entry => entry.outcome === 'planned' && entry.dryRun)).toBe(true)
		// Nothing changed in the world.
		expect(world.stateOf(ECS)).toBe('active')
		expect(world.stateOf(S3)).toBe('active')
	})

	it('Suspends compute + storage when run for real', async () => {
		const world = createFakeWorld([
			{ arn: ECS, service: 'ecs' },
			{ arn: S3, service: 's3' },
		])

		const result = await deprovision({}, 'suspend', {
			discover: () => world.discover(),
			actuator: world.actuator,
			dryRun: false,
			now: fixedNow,
		})

		expect(result.summary.suspended).toBe(2)
		expect(world.stateOf(ECS)).toBe('suspended')
		expect(world.stateOf(S3)).toBe('suspended')
	})

	it('Resumes suspended resources', async () => {
		const world = createFakeWorld([
			{ arn: ECS, service: 'ecs', state: 'suspended' },
			{ arn: S3, service: 's3', state: 'suspended' },
		])

		const result = await deprovision({}, 'resume', {
			discover: () => world.discover(),
			actuator: world.actuator,
			dryRun: false,
		})

		expect(result.summary.resumed).toBe(2)
		expect(world.stateOf(ECS)).toBe('active')
	})

	it('Tears resources down and records an audit entry for each', async () => {
		const world = createFakeWorld([
			{ arn: ECS, service: 'ecs' },
			{ arn: ECR, service: 'ecr' },
			{ arn: S3, service: 's3' },
		])

		const result = await deprovision({ label: 'acme' }, 'teardown', {
			discover: () => world.discover(),
			actuator: world.actuator,
			dryRun: false,
			now: fixedNow,
		})

		expect(result.summary.deleted).toBe(3)
		expect(world.stateOf(ECS)).toBe('gone')
		expect(world.stateOf(ECR)).toBe('gone')
		expect(world.stateOf(S3)).toBe('gone')
		expect(result.entries).toHaveLength(3)
		expect(result.entries[0]).toMatchObject({ action: 'delete', dryRun: false, mode: 'teardown' })
	})

	it('Stops compute before storage (cost-stop first)', async () => {
		// Seed storage first to prove the engine reorders, not just preserves input order.
		const world = createFakeWorld([
			{ arn: S3, service: 's3' },
			{ arn: ECR, service: 'ecr' },
			{ arn: ECS, service: 'ecs' },
		])

		const result = await deprovision({}, 'teardown', {
			discover: () => world.discover(),
			actuator: world.actuator,
			dryRun: false,
		})

		expect(result.entries.map(entry => entry.service)).toEqual(['ecs', 'ecr', 's3'])
	})

	it('Tolerates already-gone resources (idempotent re-run)', async () => {
		const world = createFakeWorld([{ arn: ECS, service: 'ecs' }])
		const options = {
			discover: () => world.discover({ includeGone: true }),
			actuator: world.actuator,
			dryRun: false,
		}

		const first = await deprovision({}, 'teardown', options)
		expect(first.summary.deleted).toBe(1)

		// Second run: the resource is gone but the tag lingers (half-deleted) — reported, not failed.
		const second = await deprovision({}, 'teardown', options)
		expect(second.summary.deleted).toBe(0)
		expect(second.summary['already-gone']).toBe(1)
		expect(second.entries[0].outcome).toBe('already-gone')
	})

	it('Fences on the Service=mf-delivery tag: untagged resources are never touched', async () => {
		const world = createFakeWorld([{ arn: ECS, service: 'ecs' }])
		const foreign: DeliveryResource = {
			arn: 'arn:aws:s3:::someone-elses-bucket',
			service: 's3',
			tags: {},
		}

		const result = await deprovision({}, 'teardown', {
			discover: discoverOf([{ arn: ECS, service: 'ecs', tags: TAG }, foreign]),
			actuator: world.actuator,
			dryRun: false,
		})

		expect(result.discovered).toBe(2)
		expect(result.fenced).toBe(1)
		expect(result.skippedByFence).toBe(1)
		expect(result.entries.map(entry => entry.arn)).toEqual([ECS])
	})

	it('Records a failure and keeps going (never aborts the sweep midway)', async () => {
		const flaky: ResourceActuator = {
			suspend: async resource => {
				if (resource.arn === ECS) throw new Error('AccessDenied: cannot stop service')
				return { outcome: 'suspended' }
			},
			resume: async () => ({ outcome: 'resumed' }),
			teardown: async () => ({ outcome: 'deleted' }),
		}

		const result = await deprovision({}, 'suspend', {
			discover: discoverOf([
				{ arn: ECS, service: 'ecs', tags: TAG },
				{ arn: S3, service: 's3', tags: TAG },
			]),
			actuator: flaky,
			dryRun: false,
		})

		expect(result.summary.failed).toBe(1)
		expect(result.summary.suspended).toBe(1)
		const ecsEntry = result.entries.find(entry => entry.arn === ECS)
		expect(ecsEntry?.outcome).toBe('failed')
		expect(ecsEntry?.reason).toContain('AccessDenied')
	})

	it('Aborts before touching anything when the signal is aborted', async () => {
		const world = createFakeWorld([{ arn: ECS, service: 'ecs' }])
		await expect(
			deprovision({}, 'teardown', {
				discover: () => world.discover(),
				actuator: world.actuator,
				dryRun: false,
				signal: AbortSignal.abort(),
			})
		).rejects.toThrow(/aborted/)
		expect(world.stateOf(ECS)).toBe('active')
	})
})

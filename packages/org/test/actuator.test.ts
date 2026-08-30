import { DeleteRepositoryCommand } from '@aws-sdk/client-ecr'
import { GetResourcesCommand } from '@aws-sdk/client-resource-groups-tagging-api'
import { DeleteBucketCommand, DeleteObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3'

import { createAwsActuator, isAlreadyGone } from '#/actuator.ts'
import { createTaggingDiscovery, serviceOfArn } from '#/discover.ts'

import type { EcrClientLike, S3ClientLike, TaggingClientLike } from '#/types.ts'

const ECR = 'arn:aws:ecr:eu-north-1:111:repository/mf-acme'
const S3 = 'arn:aws:s3:::mf-acme'

describe('isAlreadyGone', () => {
	it('Recognises the manual-teardown failure shapes', () => {
		expect(isAlreadyGone(new Error('Service not found'))).toBe(true)
		expect(isAlreadyGone({ name: 'NoSuchBucket' })).toBe(true)
		expect(isAlreadyGone({ Code: 'RepositoryNotFoundException' })).toBe(true)
		expect(isAlreadyGone(new Error('Creation of service was not idempotent'))).toBe(true)
		expect(isAlreadyGone(new Error('AccessDenied'))).toBe(false)
	})
})

describe('createAwsActuator', () => {
	it('Tears down an ECR repository with force', async () => {
		const sent: string[] = []
		const ecr = {
			send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
				sent.push(command.constructor.name)
				expect(command).toBeInstanceOf(DeleteRepositoryCommand)
				expect(command.input).toMatchObject({ repositoryName: 'mf-acme', force: true })
				return {}
			},
		} as unknown as EcrClientLike

		const actuator = createAwsActuator({ clients: { ecr } })
		const result = await actuator.teardown({ arn: ECR, service: 'ecr', tags: {} })

		expect(result.outcome).toBe('deleted')
		expect(sent).toEqual(['DeleteRepositoryCommand'])
	})

	it('Empties then deletes an S3 bucket on teardown', async () => {
		const sent: string[] = []
		const s3 = {
			send: async (command: { constructor: { name: string } }) => {
				sent.push(command.constructor.name)
				if (command instanceof ListObjectsV2Command) {
					return { Contents: [{ Key: 'a' }, { Key: 'b' }], IsTruncated: false }
				}
				if (command instanceof DeleteObjectsCommand) return {}
				if (command instanceof DeleteBucketCommand) return {}
				throw new Error('unexpected')
			},
		} as unknown as S3ClientLike

		const actuator = createAwsActuator({ clients: { s3 } })
		const result = await actuator.teardown({ arn: S3, service: 's3', tags: {} })

		expect(result).toMatchObject({ outcome: 'deleted', detail: { objectsDeleted: 2 } })
		expect(sent).toEqual(['ListObjectsV2Command', 'DeleteObjectsCommand', 'DeleteBucketCommand'])
	})

	it('Keeps storage on suspend (no handler → skipped)', async () => {
		const s3 = { send: async () => ({}) } as unknown as S3ClientLike
		const actuator = createAwsActuator({ clients: { s3 } })

		const result = await actuator.suspend({ arn: S3, service: 's3', tags: {} })
		expect(result.outcome).toBe('skipped')
	})

	it('SAFETY: teardown of an unhandled service FAILS (throws), never silently skips', async () => {
		// No ecs handler is wired: a compute/secrets resource with no delete path must not be
		// reported as a success — the engine records the throw as `failed`, surfacing it.
		const actuator = createAwsActuator({ clients: {} })
		await expect(
			actuator.teardown({ arn: 'arn:aws:ecs:x:1:service/y', service: 'ecs', tags: {} })
		).rejects.toThrow(/no teardown handler for service 'ecs'/)
	})

	it('cascadeManaged: skips (not fails) a service owned by a handled service lifecycle', async () => {
		// An Express service's managed fleet (target group, ENIs, autoscaling, alarm, cert) carries
		// the delivery tags but cascades with the service delete — teardown must skip, never fail.
		const actuator = createAwsActuator({
			clients: {},
			cascadeManaged: ['elasticloadbalancing', 'application-autoscaling'],
		})
		const tg = { arn: 'arn:aws:elasticloadbalancing:x:1:targetgroup/z', service: 'elasticloadbalancing', tags: {} }
		const teardown = await actuator.teardown(tg)
		expect(teardown.outcome).toBe('skipped')
		expect(teardown.reason).toMatch(/cascades with the service/)
		// Same on suspend (Express suspend deletes the service, cascading the fleet too).
		expect((await actuator.suspend(tg)).outcome).toBe('skipped')
		// A type NOT in cascadeManaged still fails closed on teardown.
		await expect(
			actuator.teardown({ arn: 'arn:aws:secretsmanager:x:1:secret/s', service: 'secretsmanager', tags: {} })
		).rejects.toThrow(/no teardown handler/)
	})

	it('Maps an already-gone error to already-gone, not a throw', async () => {
		const ecr = {
			send: async () => {
				throw Object.assign(new Error('RepositoryNotFoundException'), { name: 'RepositoryNotFoundException' })
			},
		} as unknown as EcrClientLike

		const actuator = createAwsActuator({ clients: { ecr } })
		const result = await actuator.teardown({ arn: ECR, service: 'ecr', tags: {} })
		expect(result.outcome).toBe('already-gone')
	})

	it('Rethrows a genuine failure so the engine records it', async () => {
		const ecr = {
			send: async () => {
				throw new Error('AccessDenied')
			},
		} as unknown as EcrClientLike

		const actuator = createAwsActuator({ clients: { ecr } })
		await expect(actuator.teardown({ arn: ECR, service: 'ecr', tags: {} })).rejects.toThrow(
			/AccessDenied/
		)
	})

	it('Uses an injected handler for an unshipped service (e.g. ECS Express)', async () => {
		const actuator = createAwsActuator({
			clients: {},
			handlers: { ecs: { suspend: async () => ({ outcome: 'suspended', detail: { via: 'injected' } }) } },
		})
		const result = await actuator.suspend({ arn: 'arn:aws:ecs:x:1:service/y', service: 'ecs', tags: {} })
		expect(result).toMatchObject({ outcome: 'suspended', detail: { via: 'injected' } })
	})
})

describe('createTaggingDiscovery', () => {
	it('Parses the service segment from an ARN', () => {
		expect(serviceOfArn(ECR)).toBe('ecr')
		expect(serviceOfArn(S3)).toBe('s3')
	})

	it('Filters on Service=mf-delivery + extra tags, paginates, maps ARNs and tags', async () => {
		const inputs: Record<string, unknown>[] = []
		const client = {
			send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
				expect(command).toBeInstanceOf(GetResourcesCommand)
				inputs.push(command.input)
				if (!command.input.PaginationToken) {
					return {
						PaginationToken: 'next',
						ResourceTagMappingList: [
							{ ResourceARN: ECR, Tags: [{ Key: 'Service', Value: 'mf-delivery' }] },
						],
					}
				}
				return {
					PaginationToken: '',
					ResourceTagMappingList: [
						{ ResourceARN: S3, Tags: [{ Key: 'Service', Value: 'mf-delivery' }] },
					],
				}
			},
		} as unknown as TaggingClientLike

		const discover = createTaggingDiscovery(client)
		const resources = await discover({ tags: { 'mf:customer': 'acme' } })

		expect(resources.map(resource => resource.arn)).toEqual([ECR, S3])
		expect(resources[0]).toMatchObject({ service: 'ecr', tags: { Service: 'mf-delivery' } })
		expect(inputs[0].TagFilters).toEqual([
			{ Key: 'Service', Values: ['mf-delivery'] },
			{ Key: 'mf:customer', Values: ['acme'] },
		])
		expect(inputs).toHaveLength(2)
	})
})

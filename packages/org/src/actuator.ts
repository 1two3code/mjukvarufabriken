import {
	DeleteBucketCommand,
	DeleteObjectsCommand,
	ListObjectsV2Command,
} from '@aws-sdk/client-s3'
import { DeleteRepositoryCommand } from '@aws-sdk/client-ecr'

import { SERVICE_TAG } from '#/constants.ts'

import type { DeliveryResource, Outcome } from '#/schemas.ts'
import type { EcrClientLike, S3ClientLike } from '#/types.ts'

/** What a single resource action reports back. `outcome: 'failed'` is signalled by throwing. */
export type ActionResult = {
	outcome: Exclude<Outcome, 'planned' | 'failed'>
	detail?: Record<string, unknown>
	reason?: string
}

/**
 * The thing that actually changes one resource. The deprovision engine owns fencing, ordering,
 * dry-run and the audit trail; the actuator owns the AWS specifics. Tests inject a fake actuator,
 * so the engine is exercised without any AWS in the loop.
 */
export type ResourceActuator = {
	suspend: (resource: DeliveryResource) => Promise<ActionResult>
	resume: (resource: DeliveryResource) => Promise<ActionResult>
	teardown: (resource: DeliveryResource) => Promise<ActionResult>
}

// MARK: already-gone detection

/**
 * The "already gone / half-deleted" errors the manual teardown kept tripping on. A teardown that
 * hits one of these is a success (the resource is gone), not a failure — that is what makes the
 * whole thing idempotent and re-runnable.
 */
export const isAlreadyGone = (error: unknown): boolean => {
	const value = error as { name?: string; Code?: string; message?: string } | undefined
	const text = `${value?.name ?? ''} ${value?.Code ?? ''} ${value?.message ?? ''}`
	return /not\s*found|does not exist|no such|already (gone|deleted|removed)|not idempotent|NoSuchBucket|NoSuchKey|NoSuchEntity|RepositoryNotFound|ServiceNotFound|ResourceNotFound/i.test(
		text
	)
}

// MARK: In-memory fake world (tests / dry-run rehearsal)

export type FakeResourceState = 'active' | 'suspended' | 'gone'

export type FakeSeed = {
	arn: string
	service: string
	tags?: Record<string, string>
	state?: FakeResourceState
}

export type FakeWorld = {
	actuator: ResourceActuator
	/** Discovery view: every resource still present (optionally including stale/half-deleted ARNs). */
	discover: (options?: { includeGone?: boolean }) => Promise<DeliveryResource[]>
	stateOf: (arn: string) => FakeResourceState | undefined
}

/**
 * A faithful in-memory stand-in for the tagged AWS resources: suspend/resume flip state, teardown
 * marks gone, and acting on a gone/unknown ARN reports `already-gone`. Used by the deprovision
 * tests to cover suspend, resume, teardown, already-gone and half-deleted end to end.
 */
export const createFakeWorld = (seed: FakeSeed[]): FakeWorld => {
	const world = new Map<string, { resource: DeliveryResource; state: FakeResourceState }>()
	for (const item of seed) {
		world.set(item.arn, {
			resource: {
				arn: item.arn,
				service: item.service,
				tags: item.tags ?? { [SERVICE_TAG.key]: SERVICE_TAG.value },
			},
			state: item.state ?? 'active',
		})
	}

	const entryFor = (arn: string) => world.get(arn)

	const actuator: ResourceActuator = {
		suspend: async resource => {
			const entry = entryFor(resource.arn)
			if (!entry || entry.state === 'gone') return { outcome: 'already-gone' }
			if (entry.state === 'suspended') return { outcome: 'suspended', detail: { noop: true } }
			entry.state = 'suspended'
			return { outcome: 'suspended' }
		},
		resume: async resource => {
			const entry = entryFor(resource.arn)
			if (!entry || entry.state === 'gone') return { outcome: 'already-gone' }
			if (entry.state === 'active') return { outcome: 'resumed', detail: { noop: true } }
			entry.state = 'active'
			return { outcome: 'resumed' }
		},
		teardown: async resource => {
			const entry = entryFor(resource.arn)
			if (!entry || entry.state === 'gone') return { outcome: 'already-gone' }
			entry.state = 'gone'
			return { outcome: 'deleted' }
		},
	}

	return {
		actuator,
		discover: async ({ includeGone = false } = {}) =>
			[...world.values()]
				.filter(entry => includeGone || entry.state !== 'gone')
				.map(entry => entry.resource),
		stateOf: arn => world.get(arn)?.state,
	}
}

// MARK: AWS actuator (production wiring)

/** A per-service handler; any op left undefined means "nothing to do for this mode → skipped". */
export type ServiceHandler = Partial<ResourceActuator>

export type AwsActuatorOptions = {
	clients: { s3?: S3ClientLike; ecr?: EcrClientLike }
	/**
	 * Extra/override handlers keyed by ARN service segment. Delivery supplies the ECS-Express-aware
	 * handler here (Express has no scale-to-zero, so suspend deletes the service — see
	 * @mf/harness ecsExpress.ts); this module ships only the handlers whose command shapes are stable.
	 */
	handlers?: Record<string, ServiceHandler>
	/**
	 * Service segments the ECS-Express service lifecycle OWNS: its managed ALB target group, ENIs,
	 * security-group rules, autoscaling target, CloudWatch alarm and ACM cert all carry the delivery
	 * tags but are created and destroyed WITH the service. Deleting the `ecs` service cascades them,
	 * so suspend/teardown of these is a deliberate no-op (`skipped`), never an unhandled-`failed`.
	 * Without this, a real teardown of ONE Express delivery reports its whole managed fleet as
	 * failures (seen: 48 tagged resources discovered for 2 services) and can never report success.
	 */
	cascadeManaged?: readonly string[]
	/** Override the already-gone matcher (defaults to `isAlreadyGone`). */
	alreadyGone?: (error: unknown) => boolean
}

const skipped = (reason: string): ActionResult => ({ outcome: 'skipped', reason })

/**
 * Storage is cheap and retained through the grace window: `suspend`/`resume` are no-ops for S3 and
 * ECR; only `teardown` deletes. Compute (ECS/App Runner) is where suspend matters and is supplied
 * via `handlers` by the caller that owns its command shapes.
 */
const s3Handler = (client: S3ClientLike): ServiceHandler => ({
	teardown: async resource => {
		const bucket = resource.arn.split(':').pop() ?? ''
		let token: string | undefined
		let deleted = 0
		do {
			const page = await client.send(
				new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token })
			)
			const objects = (page.Contents ?? []).flatMap(entry => (entry.Key ? [{ Key: entry.Key }] : []))
			if (objects.length > 0) {
				await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects } }))
				deleted += objects.length
			}
			token = page.IsTruncated ? page.NextContinuationToken : undefined
		} while (token)
		await client.send(new DeleteBucketCommand({ Bucket: bucket }))
		return { outcome: 'deleted', detail: { bucket, objectsDeleted: deleted } }
	},
})

const ecrHandler = (client: EcrClientLike): ServiceHandler => ({
	teardown: async resource => {
		const repositoryName = resource.arn.split('repository/').pop() ?? resource.arn.split('/').pop() ?? ''
		await client.send(new DeleteRepositoryCommand({ repositoryName, force: true }))
		return { outcome: 'deleted', detail: { repositoryName } }
	},
})

/**
 * A production actuator that dispatches by ARN service segment to a handler registry. Handlers for
 * S3 and ECR ship here; ECS/others are injected via `handlers`. An already-gone error from any
 * handler becomes `already-gone` rather than a failure — so the whole run is idempotent and
 * half-deleted-tolerant.
 *
 * Missing-handler policy is mode-dependent:
 * - suspend/resume of an unhandled service is a genuine no-op (e.g. S3/ECR have nothing to pause),
 *   so it is a recorded `skipped`.
 * - teardown of an unhandled service THROWS (surfaced as `failed` by the engine). A teardown must
 *   never report success while a resource type with no delete path — compute, secrets — is left
 *   standing behind it; silently `skipped` would hide exactly that.
 */
export const createAwsActuator = (options: AwsActuatorOptions): ResourceActuator => {
	const { clients, handlers = {}, alreadyGone = isAlreadyGone, cascadeManaged = [] } = options
	const cascade = new Set(cascadeManaged)
	const registry: Record<string, ServiceHandler> = {
		...(clients.s3 ? { s3: s3Handler(clients.s3) } : {}),
		...(clients.ecr ? { ecr: ecrHandler(clients.ecr) } : {}),
		...handlers,
	}

	const dispatch =
		(mode: keyof ResourceActuator) =>
		async (resource: DeliveryResource): Promise<ActionResult> => {
			const handler = registry[resource.service]?.[mode]
			if (!handler) {
				// Owned by a handled service's lifecycle (e.g. an Express service's managed fleet): the
				// service's own delete cascades it, so this is a deliberate no-op, not a failure.
				if (cascade.has(resource.service)) {
					return skipped(`'${resource.service}' is managed by its ECS Express service — cascades with the service delete`)
				}
				if (mode === 'teardown') {
					throw new Error(
						`no teardown handler for service '${resource.service}' — refusing to report success ` +
							`while ${resource.arn} may remain (compute/secrets left standing)`
					)
				}
				return skipped(`no ${mode} handler for service '${resource.service}'`)
			}
			try {
				return await handler(resource)
			} catch (error) {
				if (alreadyGone(error)) return { outcome: 'already-gone', reason: (error as Error).message }
				throw error
			}
		}

	return { suspend: dispatch('suspend'), resume: dispatch('resume'), teardown: dispatch('teardown') }
}

import { createHash } from 'node:crypto'

import { CreateExpressGatewayServiceCommand } from '@aws-sdk/client-ecs'

import type { ECSClient, ECSExpressGatewayService } from '@aws-sdk/client-ecs'
import type { DeployedServiceConfig } from '@mf/models'
import type { AuditEntry, DeprovisionResult, Outcome, OutcomeTally } from '@mf/org'

/** The one method of `ECSClient` the redeploy uses — a `{ send }` fake in tests */
export type EcsClientLike = Pick<ECSClient, 'send'>

/** A recorded service to re-stand-up: an opaque handle (the DB row id), plus the create config. */
export type RedeployInput = {
	id: string
	serviceName: string
	config?: DeployedServiceConfig | null
}

/** Per-service outcome, carrying the NEW arn so the caller can write it back to the record. */
export type RedeployItem = {
	id: string
	serviceName: string
	outcome: Outcome
	serviceArn?: string
	reason?: string
}

/**
 * A {@link DeprovisionResult} (so the lifecycle response summary is uniform with suspend/teardown)
 * plus the per-service items — the caller updates each recorded row's arn from `items`.
 */
export type RedeployResult = DeprovisionResult & { items: RedeployItem[] }

const emptyTally = (): OutcomeTally => ({
	planned: 0,
	suspended: 0,
	resumed: 0,
	deleted: 0,
	skipped: 0,
	'already-gone': 0,
	failed: 0,
})

/** ECS answers a create for a service that is already up with one of these — treat it as resumed. */
const isAlreadyCreated = (error: unknown) =>
	/not idempotent|already exists|already created/i.test((error as Error).message ?? '')

/**
 * A deterministic idempotency token from the service name (mirrors the delivery client): an SDK
 * retry re-sends the same token so ECS returns the original service instead of erroring.
 */
export const redeployClientToken = (serviceName: string) =>
	`mf-${createHash('sha256').update(serviceName).digest('hex').slice(0, 60)}`

const publicEndpointArn = (service?: ECSExpressGatewayService) => service?.serviceArn

/**
 * Re-stands-up each recorded Express service from its stored create config (wave 10,
 * delivery-lifecycle-followups). ECS Express has no scale-to-zero, so a suspend DELETED the
 * service; `resume` replays the exact `CreateExpressGatewayService` input — same image, roles,
 * port and environment — so the app comes back with its identity intact rather than a fresh
 * redelivery being owed. Idempotent: a service that still exists (an SDK retry, a resume of a
 * never-suspended order) reports `resumed`, not a failure.
 *
 * LIVE-UNVERIFIED: the `CreateExpressGatewayService` API is post-cutoff, exercised only by fakes.
 */
export const redeployExpressServices = async (
	services: RedeployInput[],
	options: {
		client: EcsClientLike
		dryRun: boolean
		now?: () => number
	}
): Promise<RedeployResult> => {
	const { client, dryRun, now = Date.now } = options
	const summary = emptyTally()
	const entries: AuditEntry[] = []
	const items: RedeployItem[] = []

	const record = (
		serviceName: string,
		outcome: Outcome,
		extra?: { serviceArn?: string; reason?: string }
	) => {
		summary[outcome] += 1
		entries.push({
			time: new Date(now()).toISOString(),
			mode: 'resume',
			arn: extra?.serviceArn ?? `service/${serviceName}`,
			service: 'ecs',
			action: 'resume',
			outcome,
			dryRun,
			...(extra?.serviceArn && { detail: { serviceArn: extra.serviceArn } }),
			...(extra?.reason && { reason: extra.reason }),
		})
	}

	for (const service of services) {
		if (dryRun) {
			record(service.serviceName, 'planned')
			items.push({ id: service.id, serviceName: service.serviceName, outcome: 'planned' })
			continue
		}
		if (!service.config) {
			// Nothing to replay — the record predates config capture; surface it rather than silently
			// reporting success while the compute stays down.
			record(service.serviceName, 'failed', { reason: 'no recorded config to redeploy from' })
			items.push({
				id: service.id,
				serviceName: service.serviceName,
				outcome: 'failed',
				reason: 'no recorded config to redeploy from',
			})
			continue
		}
		const item = await createService(client, service)
		record(service.serviceName, item.outcome, {
			serviceArn: item.serviceArn,
			reason: item.reason,
		})
		items.push(item)
	}

	return {
		mode: 'resume',
		dryRun,
		discovered: services.length,
		fenced: services.length,
		skippedByFence: 0,
		entries,
		summary,
		items,
	}
}

const createService = async (
	client: EcsClientLike,
	service: RedeployInput
): Promise<RedeployItem> => {
	const createInput = {
		...(service.config as Record<string, unknown>),
		clientToken: redeployClientToken(service.serviceName),
	}
	try {
		const result = (await client.send(
			new CreateExpressGatewayServiceCommand(createInput as never)
		)) as { service?: ECSExpressGatewayService }
		return {
			id: service.id,
			serviceName: service.serviceName,
			outcome: 'resumed',
			serviceArn: publicEndpointArn(result.service),
		}
	} catch (error) {
		// An already-up service (SDK retry, resume of a never-suspended order) is a success, not a
		// failure — the compute is running, which is exactly what resume wants.
		if (isAlreadyCreated(error)) {
			return { id: service.id, serviceName: service.serviceName, outcome: 'resumed' }
		}
		return {
			id: service.id,
			serviceName: service.serviceName,
			outcome: 'failed',
			reason: error instanceof Error ? error.message : String(error),
		}
	}
}

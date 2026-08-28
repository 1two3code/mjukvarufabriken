import fp from 'fastify-plugin'
import { DeleteExpressGatewayServiceCommand, ECSClient } from '@aws-sdk/client-ecs'
import { ECRClient } from '@aws-sdk/client-ecr'
import { OrganizationsClient } from '@aws-sdk/client-organizations'
import { ResourceGroupsTaggingAPIClient } from '@aws-sdk/client-resource-groups-tagging-api'
import { S3Client } from '@aws-sdk/client-s3'
import {
	createAwsActuator,
	createTaggingDiscovery,
	deprovision,
	moveToCustomerOu,
	vendAccount,
} from '@mf/org'

import type { FastifyPluginAsync } from 'fastify'
import type {
	ActionResult,
	DeprovisionMode,
	DeprovisionResult,
	Discover,
	ResourceActuator,
	ServiceHandler,
} from '@mf/org'

declare module 'fastify' {
	interface FastifyInstance {
		/**
		 * The @mf/org account-lifecycle seam (org-accounts.md, teardown-deprovisioning.md). Every
		 * AWS client is injected inside here and newed up only when `configured`; tests replace the
		 * whole decorator with a fake (`__mocks__/org.ts`), so nothing here touches AWS in a test.
		 */
		org: {
			/**
			 * True when the real AWS clients are wired (`ORG_LIFECYCLE_ENABLED`). While false, `vend`
			 * refuses and `deprovision` runs against an empty world — every call is effectively a
			 * dry-run and the DB lifecycle transition is the only lasting effect.
			 */
			configured: boolean
			/**
			 * Vend (or reuse) the per-customer AWS account and move it into the Customers OU. Throws
			 * `OrgNotConfigured` when the clients are not wired — the onboarding step catches that and
			 * records nothing. Idempotent (an existing account for the slug is reused).
			 */
			vend: (customerSlug: string) => Promise<{ accountId: string; reused: boolean }>
			/**
			 * Suspend / resume / teardown the customer's tagged resources. DRY-RUN unless
			 * `dryRun: false`; a real suspend/teardown is fenced to `Customer=<slug>` (@mf/org refuses
			 * an unscoped destructive run). Returns the full audited result (discovered / fenced /
			 * per-resource outcomes) so the caller can surface it.
			 */
			deprovision: (
				target: { customerSlug: string; label?: string },
				mode: DeprovisionMode,
				options?: { dryRun?: boolean }
			) => Promise<DeprovisionResult>
		}
	}
}

/** The account-vending / deprovision clients are not wired (`ORG_LIFECYCLE_ENABLED` is off). */
export class OrgNotConfigured extends Error {
	constructor() {
		super('Account lifecycle is not configured (ORG_LIFECYCLE_ENABLED is off)')
	}
}

/** Nothing to discover when the clients are not wired — a real teardown then affects only the DB row. */
const emptyDiscover: Discover = async () => []

/**
 * ECS Express has no scale-to-zero: a suspend deletes the service (the managed ALB + tasks go with
 * it) exactly as a teardown does — the cheap storage (repo/ECR/S3) is what the grace window
 * retains. `resume` is a no-op here (re-standing-up the service is a redelivery the harness owns),
 * so it is reported `skipped`. LIVE-UNVERIFIED: the Express delete API is post-cutoff.
 */
const ecsExpressHandler = (client: ECSClient): ServiceHandler => {
	const deleteService = async (arn: string): Promise<ActionResult> => {
		await client.send(new DeleteExpressGatewayServiceCommand({ serviceArn: arn }))
		return { outcome: 'deleted', detail: { serviceArn: arn } }
	}
	return {
		suspend: resource => deleteService(resource.arn),
		teardown: resource => deleteService(resource.arn),
		resume: async () => ({ outcome: 'skipped', reason: 'ECS Express resume is a redelivery' }),
	}
}

const plugin: FastifyPluginAsync = async app => {
	const { enabled, region, customersOuId } = app.secrets.orgLifecycle

	if (!enabled) {
		app.log.info('Account lifecycle disabled — deprovision runs dry against an empty world')
		app.decorate('org', {
			configured: false,
			vend: async () => {
				throw new OrgNotConfigured()
			},
			deprovision: (target, mode, options) =>
				deprovision(target, mode, {
					discover: emptyDiscover,
					actuator: {} as ResourceActuator, // never reached: nothing is discovered
					dryRun: options?.dryRun ?? true,
				}),
		})
		return
	}

	const organizations = new OrganizationsClient({ region })
	const tagging = new ResourceGroupsTaggingAPIClient({ region })
	const s3 = new S3Client({ region })
	const ecr = new ECRClient({ region })
	const ecs = new ECSClient({ region })
	app.addHook('onClose', async () => {
		organizations.destroy()
		tagging.destroy()
		s3.destroy()
		ecr.destroy()
		ecs.destroy()
	})

	const discover = createTaggingDiscovery(tagging)
	const actuator = createAwsActuator({
		clients: { s3, ecr },
		handlers: { ecs: ecsExpressHandler(ecs) },
	})

	app.decorate('org', {
		configured: true,
		vend: async customerSlug => {
			const result = await vendAccount(
				{ customerSlug },
				{ client: organizations, log: (message, detail) => app.log.info(detail, message) }
			)
			if (customersOuId) {
				await moveToCustomerOu(result.accountId, {
					client: organizations,
					customerOuId: customersOuId,
					log: (message, detail) => app.log.info(detail, message),
				}).catch(error => app.log.warn({ err: error }, 'move to Customers OU failed'))
			}
			return { accountId: result.accountId, reused: result.reused }
		},
		deprovision: (target, mode, options) =>
			deprovision(target, mode, {
				discover,
				actuator,
				dryRun: options?.dryRun ?? true,
				audit: undefined,
			}),
	})
}

export default fp(plugin, { name: '#internal/org', dependencies: ['#internal/secrets'] })

import { z } from 'zod'

/**
 * A deployed customer service, tracked PER ORDER (docs/backlog/teardown-deprovisioning.md,
 * wave-10 delivery-lifecycle-followups).
 *
 * ECS Express has no scale-to-zero, so a suspend DELETES the service and a resume must
 * re-stand it up from scratch. Tag-based discovery (`@mf/org`) only ever finds the resources
 * that still exist under the NEWEST `Customer=<slug>` fence, so it misses (a) a rebuilt order's
 * earlier deliveries — each mints its own job-unique fence — and (b) a suspended (deleted)
 * service there is nothing left to discover. Recording every service delivery makes both cases
 * work: teardown targets EVERY recorded service for the order, and resume replays the recorded
 * image/config to re-create the deleted service.
 */

/**
 * The `CreateExpressGatewayService` input the deploy client used, kept verbatim so `resume` can
 * replay it to re-stand-up the deleted service with the SAME image, roles, port and environment
 * (regenerating the env would mint fresh JWT/VAPID secrets and orphan the app's data). `.loose()`
 * tolerates the full AWS shape without this schema having to track every optional field of it.
 */
export const DeployedServiceConfigSchema = z
	.object({
		serviceName: z.string().min(1),
		cluster: z.string().optional(),
		infrastructureRoleArn: z.string().optional(),
		executionRoleArn: z.string().optional(),
		healthCheckPath: z.string().optional(),
		cpu: z.string().optional(),
		memory: z.string().optional(),
		tags: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
		primaryContainer: z
			.object({
				image: z.string().optional(),
				containerPort: z.number().int().optional(),
				environment: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
				awsLogsConfiguration: z
					.object({ logGroup: z.string(), logStreamPrefix: z.string().optional() })
					.optional(),
			})
			.loose()
			.optional(),
	})
	.loose()
export type DeployedServiceConfig = z.infer<typeof DeployedServiceConfigSchema>

/**
 * What delivery REPORTS about the service it stood up — carried on the {@link Deliverable} so the
 * api can record it (`apps/api` records it when a job reports a `deployUrl`). `config` is what
 * `resume` needs to re-create the service; `customerTag` is the `Customer=<slug>` fence a teardown
 * scopes to.
 */
export const DeployedServiceReportSchema = z.object({
	serviceName: z.string().min(1),
	serviceArn: z.string().nullable().optional(),
	customerTag: z.string().min(1),
	image: z.string().nullable().optional(),
	config: DeployedServiceConfigSchema.optional(),
})
export type DeployedServiceReport = z.infer<typeof DeployedServiceReportSchema>

/** The recorded (stored) deployed service for an order. */
export const DeployedServiceSchema = z.object({
	id: z.string(),
	orderId: z.string(),
	/** The build that produced this service, when known. */
	jobId: z.string().nullable().optional(),
	serviceName: z.string(),
	/** Null once a suspend deleted the service (its compute is gone; the record retains the config). */
	serviceArn: z.string().nullable().optional(),
	customerTag: z.string(),
	image: z.string().nullable().optional(),
	config: DeployedServiceConfigSchema.nullable().optional(),
	createdAt: z.string(),
	/** Set when a teardown permanently removed the service (soft-deleted record). */
	deletedAt: z.string().nullable().optional(),
})
export type DeployedService = z.infer<typeof DeployedServiceSchema>

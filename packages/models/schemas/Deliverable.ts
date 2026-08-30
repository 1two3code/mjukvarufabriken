import { z } from 'zod'

import { DeployedServiceReportSchema } from './DeployedService.ts'

// MARK: Enums
/** Delivery steps in run order; each one is emitted as a `delivery` job event */
export const deliveryStep = ['docs', 'repo', 'deploy', 'bundle'] as const
export type DeliveryStep = (typeof deliveryStep)[number]

// MARK: Files
/** Names of the files in the deliverable bundle (`deliverables/<jobId>/<name>`) */
export const deliverableFileName = [
	'repo.zip',
	'HANDOVER.md',
	'TEST-REPORT.md',
	'gates.json',
	'acceptance.json',
] as const
export type DeliverableFileName = (typeof deliverableFileName)[number]

export const DeliverableFileSchema = z.object({
	name: z.enum(deliverableFileName),
	/** Object key in the artifacts bucket */
	key: z.string().min(1),
	size: z.number().int().nonnegative(),
})
export type DeliverableFile = z.infer<typeof DeliverableFileSchema>

// MARK: Deliverable
/**
 * What a finished job hands over (M5). The repo push and the bundle are the contract; the
 * ECS Express deployment is best effort — `deployUrl` is null when it failed (a `notify` event
 * tells the admins). Stored as the payload of the final `delivery` event (`step: 'bundle'`).
 */
export const DeliverableSchema = z.object({
	jobId: z.string(),
	/** `https://github.com/<org>/<slug>` */
	repositoryUrl: z.string(),
	/** True when the customer's GitHub login was unknown — an admin adds them by hand */
	transferPending: z.boolean(),
	deployUrl: z.string().nullable(),
	/**
	 * The Express service delivery stood up (name/arn/image + the config `resume` replays), so
	 * the api can record it per order for teardown + resume. Absent when the deploy was skipped
	 * or failed (`deployUrl` null), or for a dry-run.
	 */
	deployedService: DeployedServiceReportSchema.optional(),
	/** Public URL of the static SPA build in the artifacts bucket, when one was built */
	siteUrl: z.string().nullable(),
	/** Prefix of the bundle in the artifacts bucket: `deliverables/<jobId>/` */
	deliverableKey: z.string().min(1),
	files: z.array(DeliverableFileSchema),
	deliveredAt: z.iso.datetime(),
})
export type Deliverable = z.infer<typeof DeliverableSchema>

// MARK: Events
/** Payload of a `delivery` job event — one per step, the final `bundle` step carries the record */
export const DeliveryEventPayloadSchema = z.object({
	step: z.enum(deliveryStep),
	ok: z.boolean(),
	url: z.string().optional(),
	reason: z.string().optional(),
	dryRun: z.boolean().optional(),
	deliverable: DeliverableSchema.optional(),
})
export type DeliveryEventPayload = z.infer<typeof DeliveryEventPayloadSchema>

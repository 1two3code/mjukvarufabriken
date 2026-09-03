import { z } from 'zod'

// MARK: Enums
/**
 * Lifecycle of an order's final export (wave 14, hosting window — strategy F4). `pending` is the
 * in-flight claim (one writer at a time: the row is the compare-and-set), `done` means every
 * file under `key` is in the artifacts bucket, `failed` means a step threw and the next sweep pass
 * may retry. Mirrors `order_exports_status_check` (migration 0024); `enumDrift.test.ts` keeps the
 * two in step.
 */
export const orderExportStatus = ['pending', 'done', 'failed'] as const
export type OrderExportStatus = (typeof orderExportStatus)[number]

/** Sub-directories / well-known names inside an export prefix */
export const orderExportFileName = {
	repo: 'repo.zip',
	database: 'database.json',
	storageManifest: 'storage-manifest.json',
	storagePrefix: 'storage/',
	deletionCertificate: 'DELETION-CERTIFICATE.md',
} as const

// MARK: Files
export const OrderExportFileSchema = z.object({
	/** Path relative to the export prefix (`repo.zip`, `database.json`, `storage/<key>`, …) */
	name: z.string().min(1),
	/** Object key in the artifacts bucket */
	key: z.string().min(1),
	size: z.number().int().nonnegative(),
})
export type OrderExportFile = z.infer<typeof OrderExportFileSchema>

// MARK: Export
/**
 * The final export of everything an order's hosting window held (repo zip, database dump, object
 * storage copy) plus — once the teardown completed — the deletion certificate. One per order;
 * every file lives under `deliverables/<jobId>/export/` in the artifacts bucket and is served to
 * the customer through presigned links (`GET /bff/orders/:orderId/export`).
 */
export const OrderExportSchema = z.object({
	orderId: z.string(),
	/** The delivered job whose bundle the export was taken from (absent when nothing was delivered) */
	jobId: z.string().optional(),
	/** Prefix of the export in the artifacts bucket: `deliverables/<jobId>/export/` */
	key: z.string().min(1),
	status: z.enum(orderExportStatus),
	files: z.array(OrderExportFileSchema),
	/** Why the last attempt failed (only with `status: 'failed'`) */
	error: z.string().optional(),
	createdAt: z.iso.datetime(),
	finishedAt: z.iso.datetime().optional(),
})
export type OrderExport = z.infer<typeof OrderExportSchema>

// MARK: Teardown
/**
 * Outcome of tearing down one job's preview resources (database + role, storage prefix + IAM
 * role) at order teardown. Every step is idempotent: `already-gone` is as good as `deleted`.
 */
export const previewTeardownOutcome = ['deleted', 'already-gone', 'skipped'] as const
export type PreviewTeardownOutcome = (typeof previewTeardownOutcome)[number]

export const PreviewTeardownReportSchema = z.object({
	jobId: z.string(),
	database: z.enum(previewTeardownOutcome),
	databaseRole: z.enum(previewTeardownOutcome),
	storageObjects: z.enum(previewTeardownOutcome),
	/** How many objects the storage prefix held before deletion */
	storageObjectCount: z.number().int().nonnegative(),
	storageRole: z.enum(previewTeardownOutcome),
	/** Why a step was skipped (no admin database / bucket configured, flag off) */
	reason: z.string().optional(),
})
export type PreviewTeardownReport = z.infer<typeof PreviewTeardownReportSchema>

import { z } from 'zod'

import { DeliverableFileSchema, DeliverableSchema } from './Deliverable.ts'

// MARK: Custom responses
/** A bundle file with a presigned download link */
export const DeliverableDownloadSchema = DeliverableFileSchema.extend({
	url: z.string(),
	expiresAt: z.iso.datetime(),
})
export type DeliverableDownload = z.infer<typeof DeliverableDownloadSchema>

/** `GET /bff/jobs/:jobId/deliverables` — the record with 15-minute download links */
export const DeliverablesResponseSchema = DeliverableSchema.omit({ deployedService: true }).extend({
	files: z.array(DeliverableDownloadSchema),
})
export type DeliverablesResponse = z.infer<typeof DeliverablesResponseSchema>

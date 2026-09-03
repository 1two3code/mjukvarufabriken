import { z } from 'zod'

import { OrderExportFileSchema, OrderExportSchema } from './OrderExport.ts'

// MARK: Custom responses
/** An export file with a presigned download link */
export const OrderExportDownloadSchema = OrderExportFileSchema.extend({
	url: z.string(),
	expiresAt: z.iso.datetime(),
})
export type OrderExportDownload = z.infer<typeof OrderExportDownloadSchema>

/** `GET /bff/orders/:orderId/export` — the export with 15-minute download links */
export const OrderExportResponseSchema = OrderExportSchema.extend({
	files: z.array(OrderExportDownloadSchema),
})
export type OrderExportResponse = z.infer<typeof OrderExportResponseSchema>

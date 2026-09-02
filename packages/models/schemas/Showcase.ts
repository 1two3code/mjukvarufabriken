import { z } from 'zod'

import { LifecycleStateSchema } from './Lifecycle.ts'
import { orderStatus } from './Order.ts'

// MARK: Showcase

/**
 * A delivered order an admin has marked for the public demo gallery (wave 14, F3; migration
 * 0023). One row per order. `url` is the live app the gallery links to — stored explicitly (it
 * defaults to the order's latest delivered deployUrl when the admin leaves it out) and absent
 * only on an unpublished draft: publishing requires one. The two blurbs are the site's languages.
 */
export const ShowcaseSchema = z.object({
	orderId: z.string(),
	/** Visible in the public gallery. Even when true, a torn-down order's row is not listed. */
	published: z.boolean(),
	title: z.string(),
	blurbSv: z.string(),
	blurbEn: z.string(),
	url: z.string().optional(),
	/** Gallery order, ascending */
	sort: z.number().int(),
	createdAt: z.iso.datetime(),
	updatedAt: z.iso.datetime(),
})
export type Showcase = z.infer<typeof ShowcaseSchema>

/** The admin list: every row with the bits of its order the admin page shows next to the form */
export const ShowcaseAdminRowSchema = ShowcaseSchema.extend({
	orderName: z.string(),
	orderStatus: z.enum(orderStatus),
	lifecycle: LifecycleStateSchema,
})
export type ShowcaseAdminRow = z.infer<typeof ShowcaseAdminRowSchema>

// MARK: Mutations
export const ShowcaseMutationSchemas = {
	/**
	 * `PUT /bff/admin/orders/:orderId/showcase` — the whole row (insert or replace). `url` omitted
	 * = resolve it from the order's latest delivered job; when that has no live URL either, a
	 * `published: true` write is refused with 409 `showcaseNoLiveUrl` (a draft may go without).
	 */
	UpsertShowcase: z
		.object({
			published: z.boolean(),
			title: z.string().trim().min(1).max(120),
			blurbSv: z.string().trim().max(600).default(''),
			blurbEn: z.string().trim().max(600).default(''),
			url: z
				.url({ protocol: /^https?$/ })
				.max(2000)
				.optional(),
			sort: z.number().int().min(-1000).max(1000).default(0),
		})
		.strict(),
}

export type ShowcaseMutation = {
	/** The input side: blurbs and sort may be left out and get their defaults */
	UpsertShowcase: z.input<typeof ShowcaseMutationSchemas.UpsertShowcase>
}

// MARK: Public gallery
/** One card of the public demo gallery (`GET /bff/showcases`), nothing an admin-only view carries */
export const ShowcaseItemSchema = z.object({
	orderId: z.string(),
	title: z.string(),
	blurb: z.object({ sv: z.string(), en: z.string() }),
	url: z.string(),
	sort: z.number().int(),
})
export type ShowcaseItem = z.infer<typeof ShowcaseItemSchema>

export const ShowcaseListResponseSchema = z.object({ items: z.array(ShowcaseItemSchema) })
export type ShowcaseListResponse = z.infer<typeof ShowcaseListResponseSchema>

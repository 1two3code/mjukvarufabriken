import fp from 'fastify-plugin'
import { rateLimitWindowStart } from '@mf/db'

import { EntityNotFound } from '#/lib/entityError.ts'
import { deliverableFromEvents } from '#/services/jobService.utils.ts'

import type { FastifyPluginAsync } from 'fastify'
import type { Showcase, ShowcaseAdminRow, ShowcaseItem } from '@mf/models'

/** What an admin writes for an order (the route's parsed body): `url` omitted = resolve it */
export type ShowcaseUpsertInput = Pick<
	Showcase,
	'published' | 'title' | 'blurbSv' | 'blurbEn' | 'sort'
> & { url?: string }

/**
 * Max public gallery reads per client ip within the window. The read is cheap (one indexed
 * query, cache-friendly for a minute) so the ceiling is generous; it only stops a single
 * address from hammering the endpoint. Same limiter shape as the contact form.
 */
export const showcaseRateLimit = { max: 60, windowMinutes: 1 } as const

/** Scope of the gallery hits in `db.rateLimits` */
export const showcaseRateLimitScope = 'showcases'

/** The ip has read the gallery `showcaseRateLimit.max` times within the window already */
export class ShowcaseRateLimited extends Error {
	constructor() {
		super('Too many gallery reads')
	}
}

/** A `published` write without a URL, for an order whose latest delivery has no live URL either */
export class ShowcaseNoLiveUrl extends Error {
	constructor(orderId: string) {
		super(`Order (${orderId}) has no live URL to showcase — supply one or leave it unpublished`)
	}
}

declare module 'fastify' {
	interface FastifyInstance {
		showcaseService: {
			/**
			 * The public demo gallery (`GET /bff/showcases`): published rows whose order is still
			 * `active` (neither suspended nor torn down), in gallery order. Throws
			 * `ShowcaseRateLimited` when `ip` exceeds the window's cap.
			 */
			listPublished: (ip: string) => Promise<ShowcaseItem[]>
			/** Every showcase row with its order's name/status/lifecycle (admin view) */
			listAdmin: () => Promise<ShowcaseAdminRow[]>
			/**
			 * Inserts or replaces the order's showcase row. A missing `url` is resolved from the
			 * order's latest delivered job (`liveUrlOf`); when that yields nothing, a `published`
			 * write throws `ShowcaseNoLiveUrl` (409) while a draft is stored without one. Throws
			 * `EntityNotFound` for an unknown order.
			 */
			upsert: (orderId: string, input: ShowcaseUpsertInput) => Promise<Showcase>
			/**
			 * The order's live URL: the `deployUrl` of the newest `delivered` job whose bundle
			 * carried one (a redelivery may have re-stood it up). Undefined when no delivery went live.
			 */
			liveUrlOf: (orderId: string) => Promise<string | undefined>
		}
	}
}

// MARK: Plugin
const windowMs = showcaseRateLimit.windowMinutes * 60 * 1000

const plugin: FastifyPluginAsync = async app => {
	const { db } = app

	const liveUrlOf = async (orderId: string) => {
		// Newest first, so the first delivered job with a URL is the current live one
		for (const job of await db.jobs.list({ orderId })) {
			if (job.status !== 'delivered') continue
			const deliverable = deliverableFromEvents(await db.jobs.listEvents(job.id))
			if (deliverable?.deployUrl) return deliverable.deployUrl
		}
		return undefined
	}

	app.decorate('showcaseService', {
		listPublished: async ip => {
			const now = new Date()
			// `rateLimitWindowStart` throws if the window ever outgrows the pruner's retention
			const since = rateLimitWindowStart(windowMs, now)
			const hits = await db.rateLimits.count(showcaseRateLimitScope, ip, since)
			if (hits >= showcaseRateLimit.max) {
				app.log.warn({ ip }, 'Showcase gallery rate limit hit')
				throw new ShowcaseRateLimited()
			}
			await db.rateLimits.record(showcaseRateLimitScope, ip, now)
			return db.showcases.listPublished()
		},
		listAdmin: () => db.showcases.list(),
		upsert: async (orderId, input) => {
			const order = await db.orders.getOrder(orderId)
			if (!order) throw new EntityNotFound('order', orderId)
			const url = input.url ?? (await liveUrlOf(orderId))
			if (input.published && !url) throw new ShowcaseNoLiveUrl(orderId)
			return db.showcases.upsert({
				orderId,
				published: input.published,
				title: input.title,
				blurbSv: input.blurbSv,
				blurbEn: input.blurbEn,
				url: url ?? null,
				sort: input.sort,
			})
		},
		liveUrlOf,
	})
}

export default fp(plugin, {
	name: '#internal/showcaseService',
	dependencies: ['#internal/db'],
})

import fp from 'fastify-plugin'
import { rateLimitWindowStart } from '@mf/db'

import { EntityNotFound } from '#/lib/entityError.ts'
import {
	hashQuoteToken,
	mintAnonymousOrgId,
	mintQuoteToken,
	toQuote,
} from '#/services/quoteService.utils.ts'
import { createEmptyDraft } from '#/services/specService.ts'

import type { FastifyPluginAsync } from 'fastify'
import type { CreateQuoteResponse, Quote } from '@mf/models'

/**
 * The anonymous quote (wave 14, F1 — "free spec chat with no login"): a visitor on the public
 * site chats with the spec engine and gets a fixed quote; the only reason to sign in is to save
 * or order it. The draft is a real order row owned by a minted `anon:*` org (the engine is keyed
 * by order id), and the visitor's proof of ownership is the quote token this service returns
 * exactly once from `create` — the row stores its sha256 (migration 0025).
 *
 * Spend and abuse bounds, cheapest first, all before any model call:
 * - `create` is per ip (a quote is free to mint, so minting is what an abuser would script);
 * - every turn goes through `specService.runTurn` with the ip scope — the per-ip window PLUS the
 *   same global ceiling the portal chat has (audit P1-2), never a separate pool;
 * - reads are per ip too, generously, so a stuck client cannot hammer the row lookups.
 * Every limit is record-then-count like the spec limiter, so a concurrent burst over-counts
 * instead of over-admitting. Windows stay inside `rateLimitRetentionMs` (`rateLimitWindowStart`).
 */
export const quoteRateLimit = { create: 3, read: 60, windowMinutes: 10 } as const

/** Scopes of the quote hits in `db.rateLimits` (turns are counted under `spec-chat-ip`) */
export const quoteRateLimitScope = { create: 'quote-create', read: 'quote-read' } as const

/**
 * GDPR retention: an unclaimed anonymous quote is deleted this many days after it was created.
 * It holds nothing but what the visitor typed, and a visitor who never came back to claim it has
 * no way to reach it again anyway (the token lives in that one browser's storage).
 */
export const anonymousQuoteRetentionDays = 30

/** The order's name until the customer renames it — the site passes its localized default */
export const defaultQuoteName = 'Offert'

/** Too many quote requests from one ip in the window — retry later */
export class QuoteRateLimited extends Error {
	constructor(scope: string, ip: string) {
		super(`Quote ${scope} from ${ip} is rate limited`)
	}
}

declare module 'fastify' {
	interface FastifyInstance {
		quoteService: {
			/**
			 * Mints an anonymous order and its quote token; the token is returned here and never
			 * again. Throws {@link QuoteRateLimited} when the ip has minted too many in the window.
			 */
			create: (ip: string, name?: string) => Promise<CreateQuoteResponse>
			/**
			 * The quote for the order — only with the matching token. A wrong token, an unknown id and
			 * an already claimed order are all EntityNotFound (indistinguishable on purpose). Throws
			 * {@link QuoteRateLimited} when the ip reads too often.
			 */
			get: (orderId: string, token: string, ip: string) => Promise<Quote>
			/**
			 * One spec-engine turn on the anonymous draft (token-checked like `get`), through
			 * `specService.runTurn` with the ip scope: the same lifetime cap, per-order/per-ip windows
			 * and global ceiling as the portal's chat, and the same errors before any model call.
			 */
			sendMessage: (orderId: string, token: string, content: string, ip: string) => Promise<Quote>
			/**
			 * Housekeeping (hourly, Postgres only — the `quoteSweeper` plugin): deletes anonymous
			 * quotes older than {@link anonymousQuoteRetentionDays} that nobody claimed. Resolves to
			 * the number deleted.
			 */
			sweepUnclaimed: () => Promise<number>
		}
	}
}

// MARK: Helpers
const windowMs = quoteRateLimit.windowMinutes * 60 * 1000
const dayMs = 24 * 60 * 60 * 1000

/** The cut-off a sweep run deletes before: `retentionDays` before `now` */
export const quoteRetentionCutoff = (now = new Date()) =>
	new Date(now.getTime() - anonymousQuoteRetentionDays * dayMs)

// MARK: Plugin
const plugin: FastifyPluginAsync = async app => {
	const { db, specService } = app

	/** Records the hit first, then refuses when the ip's window is over `max` */
	const countHit = async (scope: string, ip: string, max: number) => {
		const now = new Date()
		const since = rateLimitWindowStart(windowMs, now)
		await db.rateLimits.record(scope, ip, now)
		const hits = await db.rateLimits.count(scope, ip, since)
		if (hits > max) {
			app.log.warn({ scope, ip, hits }, 'Quote rate limit hit')
			throw new QuoteRateLimited(scope, ip)
		}
	}

	/** The anonymous draft behind a valid (id, token) pair; EntityNotFound for anything else */
	const authorisedDraft = async (orderId: string, token: string) => {
		const order = await db.orders.getOrderByQuoteToken(orderId, hashQuoteToken(token))
		const draft = order && (await db.orders.get(orderId))
		if (!draft) throw new EntityNotFound('quote', orderId)
		return draft
	}

	app.decorate('quoteService', {
		create: async (ip, name = defaultQuoteName) => {
			await countHit(quoteRateLimitScope.create, ip, quoteRateLimit.create)
			const token = mintQuoteToken()
			const order = await db.orders.insert({
				id: crypto.randomUUID(),
				orgId: mintAnonymousOrgId(),
				name,
				quoteTokenHash: hashQuoteToken(token),
			})
			return { quote: toQuote(createEmptyDraft(order.id, order.orgId)), token }
		},
		get: async (orderId, token, ip) => {
			await countHit(quoteRateLimitScope.read, ip, quoteRateLimit.read)
			return toQuote(await authorisedDraft(orderId, token))
		},
		sendMessage: async (orderId, token, content, ip) => {
			const draft = await authorisedDraft(orderId, token)
			// The anonymous org is always set (`insert` requires one); the ip is the extra window
			const stored = await specService.runTurn(draft, content, { orgId: draft.orgId ?? '', ip })
			return toQuote(stored)
		},
		sweepUnclaimed: async () => {
			const deleted = await db.orders.deleteAnonymousBefore(quoteRetentionCutoff())
			if (deleted) app.log.info({ deleted }, 'Swept unclaimed anonymous quotes')
			return deleted
		},
	})
}

export default fp(plugin, {
	name: '#internal/quoteService',
	dependencies: ['#internal/db', '#internal/specService'],
})

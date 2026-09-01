import fp from 'fastify-plugin'
import { createSpecEngine, estimatePrice, sizePricesFromTiers } from '@mf/harness'
import { rateLimitWindowStart } from '@mf/db'
import { isSpecComplete } from '@mf/models'

import { EntityInvalid, EntityNotFound } from '#/lib/entityError.ts'

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import type { BackendSession, ChatMessage, SpecDraft } from '@mf/models'

/**
 * Ceilings on the spec chat (audit P1-2). Every turn is a paid Anthropic call, `spec:write` is
 * granted to the plain `user` role and `POST /bff/orders` mints orders without a quota, so until
 * these landed any signed-in customer could drive unbounded model spend from the portal.
 *
 * Three layers, cheapest first:
 * - `maxTurns` — a hard lifetime cap per draft. A spec that is not settled in this many turns is a
 *   conversation that has gone wrong, not one that needs another 500 turns.
 * - `maxTurnsPerOrder` — burst control within the window, so one order cannot be hammered.
 * - `maxTurnsPerOrg` — the ceiling that actually binds: an order-scoped limit alone is bypassed by
 *   minting more orders, which costs the caller nothing.
 *
 * The window must stay inside `rateLimitRetentionMs` — `rateLimitWindowStart` throws if it does not.
 */
export const specChatLimits = {
	maxTurns: 60,
	maxTurnsPerOrder: 20,
	maxTurnsPerOrg: 60,
	windowMinutes: 10,
} as const

/** Scopes of the spec-chat hits in `db.rateLimits`; separate scopes keep the two key spaces apart */
export const specChatRateLimitScope = { order: 'spec-chat-order', org: 'spec-chat-org' } as const

/** The draft has used up {@link specChatLimits.maxTurns} — no further turn will ever be allowed */
export class SpecTurnLimitReached extends Error {
	constructor(orderId: string) {
		super(`Spec chat for order ${orderId} reached its turn limit (${specChatLimits.maxTurns})`)
	}
}

/** Too many turns within the window, for this order or across the org. Retry later. */
export class SpecRateLimited extends Error {
	constructor(orderId: string) {
		super(`Spec chat for order ${orderId} is rate limited`)
	}
}

declare module 'fastify' {
	interface FastifyInstance {
		specService: {
			/**
			 * Returns the draft for the order. Unknown ids and another org's draft are
			 * EntityNotFound (admins see every draft) — orders are only created by `POST /bff/orders`.
			 */
			get: (orderId: string, session: BackendSession) => Promise<SpecDraft>
			/**
			 * Runs one spec-engine turn and stores the updated draft. Throws EntityInvalid when frozen,
			 * {@link SpecTurnLimitReached} once the draft has used its lifetime turn budget and
			 * {@link SpecRateLimited} when the per-order or per-org window is full — all three before
			 * any model call, so a refused turn costs nothing.
			 */
			sendMessage: (orderId: string, content: string, session: BackendSession) => Promise<SpecDraft>
			/** Freezes a complete draft and fixes its price. Throws EntityInvalid when incomplete. */
			freeze: (orderId: string, session: BackendSession) => Promise<SpecDraft>
		}
	}
}

export const createEmptyDraft = (orderId: string, orgId?: string): SpecDraft => ({
	orderId,
	orgId,
	status: 'drafting',
	spec: {},
	messages: [],
	openQuestions: [],
})

const chatMessage = (role: ChatMessage['role'], content: string): ChatMessage => ({
	role,
	content,
	createdAt: new Date().toISOString(),
})

const windowMs = specChatLimits.windowMinutes * 60 * 1000

const plugin: FastifyPluginAsync = async app => {
	const { db, anthropic, secrets } = app
	const engine = createSpecEngine({ client: anthropic, model: secrets.specModel })

	/**
	 * Build prices per size class from the operator-editable `pricing_tiers` table. An empty
	 * table (the in-memory db, a fresh install) falls back to the ladder defaults in
	 * `priceForSize`; a db error fails the request rather than quoting a stale default.
	 */
	const sizePrices = async () => sizePricesFromTiers(await db.pricingTiers.list())

	/**
	 * Counts one turn against both windows and refuses when either is full. The hit is recorded
	 * BEFORE the engine call, like the contact-form limiter: the tokens are spent the moment the
	 * request goes out, so a turn that then fails must still count — otherwise a caller who makes
	 * the engine fail gets unlimited free retries.
	 */
	const countTurn = async (orderId: string, orgId: string) => {
		// Throws if the window ever outgrows what the pruner retains (a silently bypassed limit)
		const now = new Date()
		const since = rateLimitWindowStart(windowMs, now)
		const [perOrder, perOrg] = await Promise.all([
			db.rateLimits.count(specChatRateLimitScope.order, orderId, since),
			db.rateLimits.count(specChatRateLimitScope.org, orgId, since),
		])
		if (perOrder >= specChatLimits.maxTurnsPerOrder || perOrg >= specChatLimits.maxTurnsPerOrg) {
			app.log.warn({ orderId, orgId, perOrder, perOrg }, 'Spec chat rate limit hit')
			throw new SpecRateLimited(orderId)
		}
		await Promise.all([
			db.rateLimits.record(specChatRateLimitScope.order, orderId, now),
			db.rateLimits.record(specChatRateLimitScope.org, orgId, now),
		])
	}

	const get: FastifyInstance['specService']['get'] = async (orderId, session) => {
		const existing = await db.orders.get(orderId)
		if (!existing || (session.role !== 'admin' && existing.orgId !== session.orgId)) {
			throw new EntityNotFound('spec', orderId)
		}
		return existing
	}

	app.decorate('specService', {
		get,
		sendMessage: async (orderId, content, session) => {
			const draft = await get(orderId, session)
			if (draft.status === 'frozen') throw new EntityInvalid('spec', orderId)
			// Two stored messages per turn (the customer's and the engine's reply)
			if (draft.messages.length >= specChatLimits.maxTurns * 2) {
				throw new SpecTurnLimitReached(orderId)
			}
			// Key on the draft's own org so an admin's turn is billed to the customer, not to
			// `org-admin` — and so a customer cannot spread turns across orgs it does not own.
			await countTurn(orderId, draft.orgId ?? session.orgId)

			const turn = await engine.nextTurn(draft, content)
			const price = turn.complete ? estimatePrice(turn.spec, await sizePrices()) : undefined
			const updated: SpecDraft = {
				...draft,
				status: turn.complete ? 'ready' : 'drafting',
				spec: turn.spec,
				openQuestions: turn.openQuestions,
				priceSek: price?.priceSek,
				messages: [
					...draft.messages,
					chatMessage('user', content),
					chatMessage('assistant', turn.assistantMessage),
				],
			}
			// The engine call takes seconds: a freeze that landed meanwhile must win, not be undone
			const stored = await db.orders.updateUnlessFrozen(updated)
			if (!stored) throw new EntityInvalid('spec', orderId)
			return stored
		},
		freeze: async (orderId, session) => {
			const draft = await get(orderId, session)
			if (draft.status === 'frozen') return draft
			if (!isSpecComplete(draft.spec)) throw new EntityInvalid('spec', orderId)

			const price = estimatePrice(draft.spec, await sizePrices())
			const frozen: SpecDraft = {
				...draft,
				status: 'frozen',
				spec: { ...draft.spec, sizeClass: price.sizeClass },
				openQuestions: [],
				priceSek: price.priceSek,
				frozenAt: new Date().toISOString(),
			}
			return db.orders.upsert(frozen)
		},
	})
}

export default fp(plugin, {
	name: '#internal/specService',
	dependencies: ['#internal/db', '#internal/anthropic', '#internal/secrets'],
})

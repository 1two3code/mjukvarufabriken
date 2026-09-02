import fp from 'fastify-plugin'
import { rateLimitWindowStart } from '@mf/db'
import {
	createSpecEngine,
	demoPriceFromTiers,
	estimatePrice,
	sizePricesFromTiers,
} from '@mf/harness'
import { isSpecComplete } from '@mf/models'

import { EntityInvalid, EntityNotFound } from '#/lib/entityError.ts'

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import type { PriceEstimate } from '@mf/harness'
import type { BackendSession, ChatMessage, PartialSpec, SpecDraft } from '@mf/models'

/**
 * Ceilings on the spec chat (audit P1-2). Every turn is a paid Anthropic call, `spec:write` is
 * granted to the plain `user` role and `POST /bff/orders` mints orders without a quota, so until
 * these landed any signed-in customer could drive unbounded model spend from the portal.
 *
 * Four layers, cheapest first:
 * - `maxTurns` — a hard lifetime cap per draft. A spec that is not settled in this many turns is a
 *   conversation that has gone wrong, not one that needs another 500 turns.
 * - `maxTurnsPerOrder` — burst control within the window, so one order cannot be hammered.
 * - `maxTurnsPerOrg` — an order-scoped limit alone is bypassed by minting more orders, which costs
 *   the caller nothing.
 * - `maxTurnsGlobal` — the only ceiling that actually bounds total spend. Per-org is bypassed one
 *   level up, exactly as per-order is bypassed by minting orders: sign-up is open and free, and
 *   `userService.findOrCreateByEmail` mints a fresh user AND a fresh org for any new address on
 *   first sign-in, so a new account resets the per-org window. This is the deployment-wide blast
 *   radius, sized well above what any plausible number of real customers chatting at once needs
 *   (four orgs can each saturate their own window simultaneously before it engages) and low enough
 *   that a scripted abuser cannot run the bill up without bound. Raise it when real traffic
 *   approaches it, not before. Same shape as `contactRateLimit.globalMax`, and counted the same
 *   way: the org scope with no key.
 *
 * The window must stay inside `rateLimitRetentionMs` — `rateLimitWindowStart` throws if it does not.
 */
export const specChatLimits = {
	maxTurns: 60,
	maxTurnsPerOrder: 20,
	maxTurnsPerOrg: 60,
	maxTurnsGlobal: 240,
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

/** Too many turns within the window — for this order, this org or the deployment. Retry later. */
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
			 * {@link SpecRateLimited} when the per-order, per-org or global window is full — all of
			 * them before any model call, so a refused turn costs nothing.
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
	 * Prices the spec for its order from the operator-editable `pricing_tiers` table. A real
	 * build is priced by its size class; a voucher demo (wave 14) at the `demo` tier whatever the
	 * class — the class is still computed and stored, it sizes the build budget. An empty table
	 * (the in-memory db, a fresh install) falls back to the ladder defaults; a db error fails the
	 * request rather than quoting a stale default.
	 */
	const priceFor = async (orderId: string, spec: PartialSpec): Promise<PriceEstimate> => {
		const [order, tiers] = await Promise.all([db.orders.getOrder(orderId), db.pricingTiers.list()])
		const estimate = estimatePrice(spec, sizePricesFromTiers(tiers))
		return order?.kind === 'demo' ? { ...estimate, priceSek: demoPriceFromTiers(tiers) } : estimate
	}

	/**
	 * Counts one turn against the order, org and global windows and refuses when any is full.
	 *
	 * RECORD FIRST, then count — deliberately the opposite order to a naive limiter. Counting first
	 * is check-then-act: with no atomicity and no in-flight accounting between the route and the
	 * engine, N concurrent requests all read a count taken before any of their INSERTs commit, all
	 * pass, and all spend a paid Anthropic call. The ceiling would then bind only on sequential
	 * callers, and sustained spend would be set by whatever concurrency the caller can open against
	 * the BFF rather than by the numbers above. Inserting the hit before reading turns that race
	 * into an over-COUNT (a turn refused that a serial caller would have been allowed, self-healing
	 * as the window slides) instead of an over-ADMIT (unbounded paid calls). A strict guarantee
	 * would need a conditional INSERT or an advisory lock keyed on the org; this is the cheap fix
	 * that fails in the safe direction.
	 *
	 * Recording before the engine call is also what the contact-form limiter does, and for the same
	 * reason: the tokens are spent the moment the request goes out, so a turn that then fails must
	 * still count — otherwise a caller who makes the engine fail gets unlimited free retries.

	 */
	const countTurn = async (orderId: string, orgId: string) => {
		// Throws if the window ever outgrows what the pruner retains (a silently bypassed limit)
		const now = new Date()
		const since = rateLimitWindowStart(windowMs, now)
		await Promise.all([
			db.rateLimits.record(specChatRateLimitScope.order, orderId, now),
			db.rateLimits.record(specChatRateLimitScope.org, orgId, now),
		])
		// `key: undefined` counts every org's hits — the deployment-wide total, no extra row needed
		const [perOrder, perOrg, global] = await Promise.all([
			db.rateLimits.count(specChatRateLimitScope.order, orderId, since),
			db.rateLimits.count(specChatRateLimitScope.org, orgId, since),
			db.rateLimits.count(specChatRateLimitScope.org, undefined, since),
		])
		// Each count already includes this turn's own hit, so a full window shows as `>`, not `>=`
		if (
			perOrder > specChatLimits.maxTurnsPerOrder ||
			perOrg > specChatLimits.maxTurnsPerOrg ||
			global > specChatLimits.maxTurnsGlobal
		) {
			app.log.warn({ orderId, orgId, perOrder, perOrg, global }, 'Spec chat rate limit hit')
			throw new SpecRateLimited(orderId)
		}
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
			// Two stored messages per turn (the customer's and the engine's reply). This read is
			// check-then-act against `updateUnlessFrozen` below, so concurrent turns can overshoot
			// the cap; `countTurn` is the layer that bounds spend under concurrency, and concurrent
			// turns on one draft already clobber each other's messages (last write wins).
			if (draft.messages.length >= specChatLimits.maxTurns * 2) {
				throw new SpecTurnLimitReached(orderId)
			}
			// Key on the draft's own org so an admin's turn is billed to the customer, not to
			// `org-admin` — and so a customer cannot spread turns across orgs it does not own.
			await countTurn(orderId, draft.orgId ?? session.orgId)

			const turn = await engine.nextTurn(draft, content)
			const price = turn.complete ? await priceFor(orderId, turn.spec) : undefined
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

			const price = await priceFor(orderId, draft.spec)
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

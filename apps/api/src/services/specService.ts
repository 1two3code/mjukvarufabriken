import fp from 'fastify-plugin'
import { createSpecEngine, estimatePrice } from '@mf/harness'
import { isSpecComplete } from '@mf/models'

import { EntityInvalid, EntityNotFound } from '#/lib/entityError.ts'
import { storeCollections } from '#/plugins/store.ts'

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import type { BackendSession, ChatMessage, SpecDraft } from '@mf/models'

declare module 'fastify' {
	interface FastifyInstance {
		specService: {
			/**
			 * Returns the draft for the order, creating an empty one owned by the session's org on
			 * first access. Another org's draft is EntityNotFound (admins see every draft).
			 */
			get: (orderId: string, session: BackendSession) => Promise<SpecDraft>
			/** Runs one spec-engine turn and stores the updated draft. Throws EntityInvalid when frozen. */
			sendMessage: (orderId: string, content: string, session: BackendSession) => Promise<SpecDraft>
			/** Freezes a complete draft and fixes its price. Throws EntityInvalid when incomplete. */
			freeze: (orderId: string, session: BackendSession) => Promise<SpecDraft>
		}
	}
}

const collection = storeCollections.specs

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

const plugin: FastifyPluginAsync = async app => {
	const { store, anthropic, secrets } = app
	const engine = createSpecEngine({ client: anthropic, model: secrets.specModel })

	const get: FastifyInstance['specService']['get'] = async (orderId, session) => {
		const existing = await store.get<SpecDraft>(collection, orderId)
		if (existing) {
			if (session.role !== 'admin' && existing.orgId !== session.orgId) {
				throw new EntityNotFound('spec', orderId)
			}
			return existing
		}
		const created = createEmptyDraft(orderId, session.orgId)
		await store.put(collection, orderId, created)
		return created
	}

	app.decorate('specService', {
		get,
		sendMessage: async (orderId, content, session) => {
			const draft = await get(orderId, session)
			if (draft.status === 'frozen') throw new EntityInvalid('spec', orderId)

			const turn = await engine.nextTurn(draft, content)
			const price = turn.complete ? estimatePrice(turn.spec) : undefined
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
			await store.put(collection, orderId, updated)
			return updated
		},
		freeze: async (orderId, session) => {
			const draft = await get(orderId, session)
			if (draft.status === 'frozen') return draft
			if (!isSpecComplete(draft.spec)) throw new EntityInvalid('spec', orderId)

			const price = estimatePrice(draft.spec)
			const frozen: SpecDraft = {
				...draft,
				status: 'frozen',
				spec: { ...draft.spec, sizeClass: price.sizeClass },
				openQuestions: [],
				priceSek: price.priceSek,
				frozenAt: new Date().toISOString(),
			}
			await store.put(collection, orderId, frozen)
			return frozen
		},
	})
}

export default fp(plugin, {
	name: '#internal/specService',
	dependencies: ['#internal/store', '#internal/anthropic', '#internal/secrets'],
})

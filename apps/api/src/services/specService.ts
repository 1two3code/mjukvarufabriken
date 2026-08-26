import fp from 'fastify-plugin'
import { createSpecEngine, estimatePrice } from '@mf/harness'
import { isSpecComplete } from '@mf/models'

import { EntityInvalid } from '#/lib/entityError.ts'
import { storeCollections } from '#/plugins/store.ts'

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import type { ChatMessage, SpecDraft } from '@mf/models'

declare module 'fastify' {
	interface FastifyInstance {
		specService: {
			/** Returns the draft for the order, creating an empty one on first access */
			get: (orderId: string) => Promise<SpecDraft>
			/** Runs one spec-engine turn and stores the updated draft. Throws EntityInvalid when frozen. */
			sendMessage: (orderId: string, content: string) => Promise<SpecDraft>
			/** Freezes a complete draft and fixes its price. Throws EntityInvalid when incomplete. */
			freeze: (orderId: string) => Promise<SpecDraft>
		}
	}
}

const collection = storeCollections.specs

export const createEmptyDraft = (orderId: string): SpecDraft => ({
	orderId,
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

	const get: FastifyInstance['specService']['get'] = async orderId => {
		const existing = await store.get<SpecDraft>(collection, orderId)
		if (existing) return existing
		const created = createEmptyDraft(orderId)
		await store.put(collection, orderId, created)
		return created
	}

	app.decorate('specService', {
		get,
		sendMessage: async (orderId, content) => {
			const draft = await get(orderId)
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
		freeze: async orderId => {
			const draft = await get(orderId)
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

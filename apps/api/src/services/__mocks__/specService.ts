import fp from 'fastify-plugin'
import { mergeDeep } from '@mf/utils/object'

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import type { PartialDeep } from 'type-fest'
import type { Spec, SpecDraft } from '@mf/models'

const defaultSpec: Spec = {
	goal: 'A booking app for a small gym with 200 members',
	users: ['members', 'staff'],
	features: [
		{
			title: 'Book a class',
			description: 'Members book a spot in a class',
			acceptanceCriteria: ['A member can book a class with free spots'],
		},
	],
	nonGoals: ['Payments'],
	stackConstraints: [],
}

export const createMockSpec = (overrides?: PartialDeep<Spec>): Spec =>
	mergeDeep(defaultSpec, overrides)

const defaultDraft: SpecDraft = {
	orderId: 'order-1',
	orgId: 'org-1',
	status: 'drafting',
	spec: { goal: 'A booking app for a small gym' },
	messages: [
		{ role: 'user', content: 'I want a booking app', createdAt: '2026-08-26T10:00:00.000Z' },
		{
			role: 'assistant',
			content: 'Great — who are the users?',
			createdAt: '2026-08-26T10:00:01.000Z',
		},
	],
	openQuestions: ['Who are the users?'],
}

export const createMockSpecDraft = (overrides?: PartialDeep<SpecDraft>): SpecDraft =>
	mergeDeep(defaultDraft, overrides)

const mockPlugin: FastifyPluginAsync = async app => {
	const mock: FastifyInstance['specService'] = {
		get: vi.fn((orderId: string) => Promise.resolve(createMockSpecDraft({ orderId }))),
		sendMessage: vi.fn(),
		runTurn: vi.fn(),
		freeze: vi.fn(),
	}

	app.decorate('specService', mock)
}

export default fp(mockPlugin, { name: '#internal/specService' })

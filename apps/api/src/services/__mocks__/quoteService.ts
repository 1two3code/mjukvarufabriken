import fp from 'fastify-plugin'
import { mergeDeep } from '@mf/utils/object'

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import type { PartialDeep } from 'type-fest'
import type { Quote } from '@mf/models'

/** A well-formed quote token (64 hex chars), never a real one */
export const mockQuoteToken = 'a'.repeat(64)

const defaultQuote: Quote = {
	orderId: 'order-1',
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
	complete: false,
}

export const createMockQuote = (overrides?: PartialDeep<Quote>): Quote =>
	mergeDeep(defaultQuote, overrides)

const mockPlugin: FastifyPluginAsync = async app => {
	const mock: FastifyInstance['quoteService'] = {
		create: vi.fn().mockResolvedValue({ quote: createMockQuote(), token: mockQuoteToken }),
		get: vi.fn((orderId: string) => Promise.resolve(createMockQuote({ orderId }))),
		sendMessage: vi.fn((orderId: string) => Promise.resolve(createMockQuote({ orderId }))),
		sweepUnclaimed: vi.fn().mockResolvedValue(0),
	}

	app.decorate('quoteService', mock)
}

export default fp(mockPlugin, { name: '#internal/quoteService' })

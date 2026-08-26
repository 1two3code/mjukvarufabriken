import fp from 'fastify-plugin'
import { mergeDeep } from '@mf/utils/object'

import { mockCheckoutUrl, mockSessionId } from '#/plugins/__mocks__/stripe.ts'

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import type { PartialDeep } from 'type-fest'
import type { Payment } from '@mf/models'

const defaultPayment: Payment = {
	id: 'payment-1',
	orderId: 'order-1',
	kind: 'deposit',
	status: 'pending',
	provider: 'stripe',
	amountSek: 7_500,
	vatSek: 1_875,
	totalSek: 9_375,
	sessionId: mockSessionId,
	createdAt: '2026-08-26T10:00:00.000Z',
}

export const createMockPayment = (overrides?: PartialDeep<Payment>): Payment =>
	mergeDeep(defaultPayment, overrides)

const mockPlugin: FastifyPluginAsync = async app => {
	const mock: FastifyInstance['paymentService'] = {
		provider: 'stripe',
		checkout: vi.fn((orderId: string, kind) =>
			Promise.resolve({ payment: createMockPayment({ orderId, kind }), url: mockCheckoutUrl })
		),
		handleWebhook: vi.fn().mockResolvedValue({
			eventId: 'evt_1',
			outcome: 'applied',
			payment: createMockPayment({ status: 'paid' }),
		}),
		completeFakeSession: vi.fn((sessionId: string) =>
			Promise.resolve(createMockPayment({ sessionId, provider: 'fake', status: 'paid' }))
		),
	}

	app.decorate('paymentService', mock)
}

export default fp(mockPlugin, { name: '#internal/paymentService' })

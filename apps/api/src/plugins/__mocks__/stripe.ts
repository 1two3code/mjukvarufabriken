import fp from 'fastify-plugin'

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import type { CheckoutInput, PaymentEvent, UsageReportInput } from '#/plugins/stripe.ts'

export const mockSessionId = 'cs_test_123'
export const mockCheckoutUrl = 'https://checkout.stripe.com/c/pay/cs_test_123'

export const createMockPaymentEvent = (overrides?: Partial<PaymentEvent>): PaymentEvent => ({
	id: 'evt_1',
	type: 'checkout.session.completed',
	sessionId: mockSessionId,
	...overrides,
})

const mockPlugin: FastifyPluginAsync = async app => {
	const mock: FastifyInstance['paymentProvider'] = {
		kind: 'stripe',
		// The first session is `mockSessionId` (matches the default event); later ones are unique
		createCheckoutSession: vi
			.fn((input: CheckoutInput) =>
				Promise.resolve({ sessionId: `cs_test_${input.paymentId}`, url: mockCheckoutUrl })
			)
			.mockResolvedValueOnce({ sessionId: mockSessionId, url: mockCheckoutUrl }),
		constructWebhookEvent: vi.fn(() => createMockPaymentEvent()),
		getSessionReceipts: vi.fn().mockResolvedValue({
			hostedInvoiceUrl: 'https://invoice.stripe.com/i/inv_1',
			receiptUrl: 'https://pay.stripe.com/receipts/r_1',
		}),
		expireSession: vi.fn().mockResolvedValue(undefined),
		reportUsage: vi.fn((input: UsageReportInput) =>
			Promise.resolve({ reference: `mtr_${input.identifier}` })
		),
	}

	app.decorate('paymentProvider', mock)
}

export default fp(mockPlugin, { name: '#internal/stripe' })

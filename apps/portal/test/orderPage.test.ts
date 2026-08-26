import { formatGateDetail, gateHeadline } from '#/features/jobs/gateReport.ts'
import { paymentOf } from '#/features/orders/payments.ts'

import type { Payment } from '@mf/models'

describe('Payments on the order page', () => {
	const payment = (overrides: Partial<Payment>): Payment => ({
		id: 'pay',
		orderId: 'order',
		kind: 'deposit',
		status: 'pending',
		provider: 'fake',
		amountSek: 100,
		vatSek: 25,
		totalSek: 125,
		sessionId: 'fake_1',
		createdAt: '2026-08-27T00:00:00.000Z',
		...overrides,
	})

	it('Finds the latest payment of a kind in a status', () => {
		const abandoned = payment({ id: 'a', sessionId: 'fake_a' })
		const paid = payment({ id: 'b', status: 'paid', paidAt: '2026-08-27T01:00:00.000Z' })
		const retried = payment({ id: 'c', sessionId: 'fake_c' })
		const payments = [abandoned, paid, retried]
		expect(paymentOf(payments, 'deposit', 'paid')).toBe(paid)
		expect(paymentOf(payments, 'deposit', 'pending')).toBe(retried)
		expect(paymentOf(payments, 'balance', 'pending')).toBeUndefined()
	})
})

describe('Gate reports', () => {
	it('Uses the first non-empty line of the summary as headline', () => {
		expect(gateHeadline('\n  \nLint passed  \nmore')).toBe('Lint passed')
		expect(gateHeadline('')).toBe('')
	})

	it('Formats scalars inline and everything else as pretty JSON', () => {
		expect(formatGateDetail('x')).toBe('x')
		expect(formatGateDetail(3)).toBe('3')
		expect(formatGateDetail(false)).toBe('false')
		expect(formatGateDetail({ a: [1] })).toBe('{\n  "a": [\n    1\n  ]\n}')
	})
})

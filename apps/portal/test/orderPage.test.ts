import {
	acceptanceGateSummary,
	formatGateDetail,
	gateHeadline,
	genericGateDetails,
	licenceGateSummary,
	reviewGateSummary,
} from '#/features/jobs/gateReport.ts'
import { orderSteps, stepsFor } from '#/features/orders/OrderStepper.tsx'
import { paymentOf } from '#/features/orders/payments.ts'

import type { GateName, GateReport, Payment } from '@mf/models'

const makeGate = (name: GateName, details?: Record<string, unknown>): GateReport => ({
	name,
	ok: true,
	startedAt: '2026-08-27T00:00:00.000Z',
	durationMs: 1000,
	tokens: 100,
	summary: 'ok',
	details,
})

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

	it('Drops the balance step for a full-upfront order (below 3 000 kr)', () => {
		expect(stepsFor(500)).toEqual(['spec', 'freeze', 'deposit', 'build', 'delivery'])
		expect(stepsFor(3_000)).toEqual([...orderSteps])
		// Price unknown while the spec is still open: show the full journey
		expect(stepsFor(undefined)).toEqual([...orderSteps])
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

	const finding = (id: string, severity: string) => ({
		id,
		severity,
		file: id.split(':')[0],
		line: 1,
		claim: 'claim',
		failureScenario: 'boom',
	})

	it('Tallies review findings by severity, preferring the post-fix set', () => {
		// After a fix pass the harness writes a fresh `findingsAfterFix`/`waiversAfterFix` pair; the
		// pre-fix `waived` ids generally do not survive into the post-fix set. The waived count must
		// come from `waiversAfterFix` (here b.ts:2, present post-fix), not the stale pre-fix `waived`
		// (a.ts:1, which no longer appears) — otherwise it maps to no finding in the shown list.
		const gate = makeGate('review', {
			findings: [finding('a.ts:1', 'high')],
			findingsAfterFix: [finding('b.ts:2', 'low'), finding('c.ts:3', 'medium')],
			waived: ['a.ts:1'],
			waiversAfterFix: ['b.ts:2'],
		})
		const summary = reviewGateSummary(gate)
		expect(summary?.counts).toEqual({ high: 0, medium: 1, low: 1 })
		expect(summary?.waived).toBe(1)
		expect(summary?.findings).toHaveLength(2)
	})

	it('Falls back to the pre-fix waiver count when no fix pass ran', () => {
		// No fix pass: only `findings` + `waived` are present, no `findingsAfterFix`/`waiversAfterFix`.
		const gate = makeGate('review', {
			findings: [finding('a.ts:1', 'high'), finding('b.ts:2', 'low')],
			waived: ['b.ts:2'],
		})
		const summary = reviewGateSummary(gate)
		expect(summary?.counts).toEqual({ high: 1, medium: 0, low: 1 })
		expect(summary?.waived).toBe(1)
	})

	it('Drops malformed review findings and returns undefined when none are present', () => {
		expect(reviewGateSummary(makeGate('review', { findings: [{ id: 'x' }] }))?.findings).toEqual(
			[]
		)
		expect(reviewGateSummary(makeGate('review'))).toBeUndefined()
	})

	it('Parses the licence gate details, or undefined for another shape', () => {
		const gate = makeGate('licence', {
			packages: 3,
			byLicence: { MIT: 3 },
			violations: [],
			waived: [],
			missing: [],
			file: 'THIRD-PARTY-LICENCES.md',
		})
		expect(licenceGateSummary(gate)?.packages).toBe(3)
		expect(licenceGateSummary(makeGate('licence', { packages: 'lots' }))).toBeUndefined()
	})

	it('Lists acceptance criteria as id → status, in numeric feature order', () => {
		// f10 must follow f2/f9, not sort lexically between f1 and f2 — the criterion list stays in
		// numeric feature order once a spec reaches 10+ features.
		const gate = makeGate('acceptance-check', {
			report: {
				'f10.c0': { evidence: [], status: 'unmet' },
				'f2.c1': { evidence: [], status: 'met' },
				'f2.c0': { evidence: [], status: 'unmet' },
				'f0.c0': { evidence: ['t.test.ts'], status: 'met' },
			},
		})
		expect(acceptanceGateSummary(gate)).toEqual([
			{ id: 'f0.c0', status: 'met' },
			{ id: 'f2.c0', status: 'unmet' },
			{ id: 'f2.c1', status: 'met' },
			{ id: 'f10.c0', status: 'unmet' },
		])
		expect(acceptanceGateSummary(makeGate('acceptance-check'))).toBeUndefined()
	})

	it('Keeps only detail keys the structured renderers do not cover', () => {
		const gate = makeGate('acceptance-tests', {
			files: { 'f0.c0': ['t.test.ts'] },
			fixed: true,
			findings: [],
		})
		expect(genericGateDetails(gate).map(([key]) => key)).toEqual(['files', 'fixed'])
	})
})

import { deliveryTimeline, hasDeliverySteps, jobOutcome } from '#/features/jobs/delivery.ts'

import type { JobEvent, OrderDetail } from '@mf/models'

// `sessionSlice` reads localStorage at module scope; OrderPage pulls it in through its hooks, so
// the stub must be in place before the page is imported
vi.stubGlobal('localStorage', {
	getItem: () => null,
	setItem: () => undefined,
	removeItem: () => undefined,
})
const { nextStep } = await import('#/features/orders/nextStep.ts')

const event = (id: number, payload: Record<string, unknown>, type: JobEvent['type'] = 'delivery') =>
	({ id, jobId: 'job-1', type, payload, createdAt: '2026-09-02T00:00:00.000Z' }) as JobEvent

describe('Delivery timeline', () => {
	it('Lists every step in run order, pending until it reports', () => {
		const timeline = deliveryTimeline([])
		expect(timeline.map(step => step.step)).toEqual([
			'docs',
			'secret-scan',
			'repo',
			'deploy',
			'acceptance',
			'bundle',
		])
		expect(timeline.every(step => step.state === 'pending')).toBe(true)
		expect(hasDeliverySteps(timeline)).toBe(false)
	})

	it('Judges each step by its LAST event; links only a passed repo / preview, never the bucket', () => {
		const timeline = deliveryTimeline([
			event(1, { budget: {} }, 'started'),
			event(2, { step: 'docs', ok: true }),
			event(3, { step: 'secret-scan', ok: true }),
			event(4, { step: 'repo', ok: true, url: 'https://github.com/x/y' }),
			event(5, { step: 'deploy', ok: true, url: 'https://x.on.aws' }),
			event(6, { step: 'acceptance', ok: false, reason: 'blank page', url: 'https://x.on.aws' }),
			// The bundle's url is an artifacts-bucket object: never a customer link
			event(7, {
				step: 'bundle',
				ok: true,
				url: 'https://artifacts.s3.eu-north-1.amazonaws.com/k',
			}),
			// A malformed delivery payload is ignored, not a crash
			event(8, { step: 'nope' }),
		])
		expect(timeline).toEqual([
			{ step: 'docs', state: 'ok', reason: undefined, url: undefined },
			{ step: 'secret-scan', state: 'ok', reason: undefined, url: undefined },
			{ step: 'repo', state: 'ok', reason: undefined, url: 'https://github.com/x/y' },
			{ step: 'deploy', state: 'ok', reason: undefined, url: 'https://x.on.aws' },
			{ step: 'acceptance', state: 'failed', reason: 'blank page', url: undefined },
			{ step: 'bundle', state: 'ok', reason: undefined, url: undefined },
		])
		expect(hasDeliverySteps(timeline)).toBe(true)
	})

	it('Keeps a step failed until a later event of the same step passes', () => {
		const timeline = deliveryTimeline([
			event(1, { step: 'deploy', ok: false, reason: 'PassRole denied' }),
			event(2, { step: 'deploy', ok: true, url: 'https://x.on.aws' }),
		])
		expect(timeline.find(step => step.step === 'deploy')).toMatchObject({ state: 'ok' })
	})

	it('Drops the static-site fallback url a FAILED deploy step points at (bucket object)', () => {
		const timeline = deliveryTimeline([
			event(1, {
				step: 'deploy',
				ok: false,
				reason: 'ecs express: boom',
				url: 'https://artifacts.s3.eu-north-1.amazonaws.com/jobs/x/site/index.html',
			}),
		])
		expect(timeline.find(step => step.step === 'deploy')).toEqual({
			step: 'deploy',
			state: 'failed',
			reason: 'ecs express: boom',
			url: undefined,
		})
	})
})

describe('Job outcome', () => {
	it('Is running while the job is active', () => {
		expect(jobOutcome({ status: 'building' })).toEqual({ kind: 'running' })
		expect(jobOutcome({ status: 'queued' }, 'https://x')).toEqual({ kind: 'running' })
	})

	it('Carries the reason of a failed or killed job', () => {
		expect(jobOutcome({ status: 'failed', reason: 'boom' })).toEqual({
			kind: 'failed',
			reason: 'boom',
		})
		expect(jobOutcome({ status: 'killed', reason: 'killed by admin' })).toEqual({
			kind: 'killed',
			reason: 'killed by admin',
		})
	})

	it('Is live only with a preview URL from the deliverable', () => {
		expect(jobOutcome({ status: 'delivered' }, 'https://x.on.aws')).toEqual({
			kind: 'live',
			url: 'https://x.on.aws',
		})
	})

	it('Is unhosted when the deliverable withheld the URL, or the row says why', () => {
		expect(jobOutcome({ status: 'delivered' }, null)).toEqual({
			kind: 'unhosted',
			reason: undefined,
		})
		expect(jobOutcome({ status: 'delivered', reason: 'acceptance: blank page' })).toEqual({
			kind: 'unhosted',
			reason: 'acceptance: blank page',
		})
	})

	it('Never claims live without the deliverable: a plain delivered row stays "delivered"', () => {
		expect(jobOutcome({ status: 'delivered' })).toEqual({ kind: 'delivered' })
	})
})

describe('Order next step', () => {
	const detail = (
		status: OrderDetail['order']['status'],
		hosting: OrderDetail['hosting']['status']
	): OrderDetail =>
		({
			order: { status },
			spec: { status: 'frozen', complete: true, openQuestions: 0 },
			hosting: { status: hosting, deployUrl: null, reason: null },
			jobs: [],
			payments: [],
		}) as unknown as OrderDetail

	it('Points a delivered order at the balance, or at "Deliver again" when unhosted', () => {
		expect(nextStep(detail('delivered', 'live'))).toBe('balance')
		expect(nextStep(detail('delivered', 'unhosted'))).toBe('balanceUnhosted')
		expect(nextStep(detail('building', 'none'))).toBe('building')
		expect(nextStep(detail('paid', 'unhosted'))).toBe('done')
	})
})

import { runRedelivery } from '#job/redeliver.ts'

import type { NewJobEvent, Plan } from '@mf/models'
import type { DeliveryInput, DeliveryOutcome } from '#job/delivery/types.ts'

const spec = { goal: 'A guestbook', users: ['visitors'], features: [], acceptance: [] } as never
const plan = { summary: 'one task', tasks: [] } as unknown as Plan
const budget = { maxTokens: 1_000_000, maxWorkers: 1, maxDurationMinutes: 30 }
const target = { slug: 'guestbook-aaaaaaaa', appName: 'Guestbook' }

const baseJob = {
	id: 'bbbbbbbb-0000-4000-8000-000000000002',
	sourceJobId: 'aaaaaaaa-0000-4000-8000-000000000001',
	spec,
	plan,
	gates: [],
	budget,
	repoDir: '/tmp/redeliver-fake',
	delivery: target,
}

const okDelivery = (input: DeliveryInput): DeliveryOutcome => ({
	ok: true,
	tokens: 0,
	steps: [],
	deliverable: {
		repositoryUrl: `https://github.com/mjukvaruhuset/${input.target.slug}`,
		deployUrl: 'https://preview.on.aws',
		deliverableKey: `deliverables/${input.jobId}/`,
	} as never,
})

describe('runRedelivery', () => {
	it('delivers the source repository under the SOURCE job\'s service name, recording under its own id', async () => {
		// Arrange
		const events: NewJobEvent[] = []
		let seen: DeliveryInput | undefined
		const deliver = async (input: DeliveryInput) => {
			seen = input
			input.onUsage({ inputTokens: 1_000, outputTokens: 200 })
			return okDelivery(input)
		}

		// Act
		const outcome = await runRedelivery(baseJob, {
			ports: { deliver },
			hooks: { emit: async event => void events.push(event) },
		})

		// Assert
		expect(outcome.status).toBe('delivered')
		expect(seen?.serviceJobId).toBe(baseJob.sourceJobId)
		expect(seen?.jobId).toBe(baseJob.id)
		expect(seen?.plan).toBe(plan)
		expect(outcome.deliverable?.deployUrl).toBe('https://preview.on.aws')
		expect(outcome.tokensUsed).toBeGreaterThan(0)
		expect(events.map(event => event.type)).toEqual(['started', 'done'])
		expect(events[0]!.payload).toMatchObject({ mode: 'redeliver', sourceJobId: baseJob.sourceJobId })
	})

	it('fails when the delivery fails, with the delivery reason', async () => {
		const outcome = await runRedelivery(baseJob, {
			ports: { deliver: async () => ({ ok: false, tokens: 0, steps: [], reason: 'deploy exploded' }) },
			hooks: { emit: async () => {} },
		})
		expect(outcome.status).toBe('failed')
		expect(outcome.reason).toMatch(/deploy exploded/)
	})

	it('fails closed when the source job has no plan (the docs would be empty)', async () => {
		let delivered = false
		const outcome = await runRedelivery(
			{ ...baseJob, plan: undefined },
			{
				ports: {
					deliver: async input => {
						delivered = true
						return okDelivery(input)
					},
				},
				hooks: { emit: async () => {} },
			}
		)
		expect(outcome.status).toBe('failed')
		expect(outcome.reason).toMatch(/no plan/)
		expect(delivered).toBe(false)
	})

	it('fails when delivery is not configured at all', async () => {
		const outcome = await runRedelivery(baseJob, {
			ports: {},
			hooks: { emit: async () => {} },
		})
		expect(outcome.status).toBe('failed')
		expect(outcome.reason).toMatch(/not configured/)
	})
})

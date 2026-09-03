import fp from 'fastify-plugin'
import { createMemoryRepositories } from '@mf/db'
import { mergeDeep } from '@mf/utils/object'

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import type { PartialDeep } from 'type-fest'
import type { Job, JobEvent } from '@mf/models'

const defaultJob: Job = {
	id: 'job-1',
	orderId: 'order-1',
	orgId: 'org-1',
	status: 'queued',
	spec: {
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
		sizeClass: 'S',
	},
	budget: { maxTokens: 2_000_000, maxWorkers: 2, maxDurationMinutes: 120 },
	tokensUsed: 0,
	createdAt: '2026-08-26T12:00:00.000Z',
}

const defaultEvent: JobEvent = {
	id: 1,
	jobId: 'job-1',
	type: 'started',
	payload: { budget: defaultJob.budget },
	createdAt: '2026-08-26T12:00:01.000Z',
}

export const createMockJob = (overrides?: PartialDeep<Job>): Job => mergeDeep(defaultJob, overrides)
export const createMockJobEvent = (overrides?: PartialDeep<JobEvent>): JobEvent =>
	mergeDeep(defaultEvent, overrides)

/**
 * Jobs are mocked with fixtures (routes/services assert on them); orders, users, auth and resident use
 * Jobs are mocked with fixtures (routes/services assert on them); orders, users, auth and rateLimits use
 * the real in-memory repositories from @mf/db, one fresh set per test app, so the services
 * exercise the same contract as Postgres. Spy with `vi.spyOn(app.db.orders, 'get')`.
 */
const mockPlugin: FastifyPluginAsync = async app => {
	const memory = createMemoryRepositories()
	const mock: FastifyInstance['db'] = {
		available: true,
		backend: 'memory',
		orders: memory.orders,
		showcases: memory.showcases,
		deployedServices: memory.deployedServices,
		users: memory.users,
		auth: memory.auth,
		resident: memory.resident,
		rateLimits: memory.rateLimits,
		iterationBrief: memory.iterationBrief,
		modelPrices: memory.modelPrices,
		pricingTiers: memory.pricingTiers,
		jobs: {
			insert: vi.fn(job => Promise.resolve(createMockJob({ ...job, id: 'job-1' }))),
			insertRetry: vi.fn(job => Promise.resolve(createMockJob({ ...job, id: 'job-2' }))),
			get: vi.fn((id: string) => Promise.resolve(createMockJob({ id }))),
			getByReportToken: vi.fn().mockResolvedValue(createMockJob()),
			list: vi.fn().mockResolvedValue([createMockJob()]),
			listStuck: vi.fn().mockResolvedValue([]),
			update: vi.fn((id: string, update) => Promise.resolve(createMockJob({ id, ...update }))),
			appendEvent: vi.fn((jobId: string, event) =>
				Promise.resolve(createMockJobEvent({ jobId, ...event }))
			),
			appendEventOnce: vi.fn((jobId: string, seq: number, event) =>
				Promise.resolve({
					event: createMockJobEvent({ id: seq, jobId, ...event }),
					duplicate: false,
				})
			),
			countEvents: vi.fn().mockResolvedValue(0),
			listEvents: vi.fn().mockResolvedValue([createMockJobEvent()]),
		},
	}

	app.decorate('db', mock)
}

export default fp(mockPlugin, { name: '#internal/db' })

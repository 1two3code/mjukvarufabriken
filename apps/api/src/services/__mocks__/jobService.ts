import fp from 'fastify-plugin'
import { mergeDeep } from '@mf/utils/object'

import { createMockJob, createMockJobEvent } from '#/plugins/__mocks__/db.ts'
import { mockPresignedUrl } from '#/plugins/__mocks__/s3.ts'

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import type { PartialDeep } from 'type-fest'
import type { Deliverable, DeliverablesResponse, Job } from '@mf/models'

const defaultDeliverable: Deliverable = {
	jobId: 'job-1',
	repositoryUrl: 'https://github.com/mjukvaruhuset/gym-booking-job1',
	transferPending: false,
	deployUrl: 'https://mf-gym-booking-job1.eu-north-1.on.aws',
	siteUrl: null,
	deliverableKey: 'deliverables/job-1/',
	files: [
		{ name: 'repo.zip', key: 'deliverables/job-1/repo.zip', size: 1024 },
		{ name: 'HANDOVER.md', key: 'deliverables/job-1/HANDOVER.md', size: 512 },
	],
	deliveredAt: '2026-08-26T13:00:00.000Z',
}

export const createMockDeliverable = (overrides?: PartialDeep<Deliverable>): Deliverable =>
	mergeDeep(defaultDeliverable, overrides)

export const createMockDeliverables = (
	overrides?: PartialDeep<Deliverable>
): DeliverablesResponse => {
	const deliverable = createMockDeliverable(overrides)
	return {
		...deliverable,
		files: deliverable.files.map(file => ({
			...file,
			url: mockPresignedUrl(file.key),
			expiresAt: '2026-08-26T13:15:00.000Z',
		})),
	}
}

const mockPlugin: FastifyPluginAsync = async app => {
	const mock: FastifyInstance['jobService'] = {
		start: vi.fn((orderId: string) => Promise.resolve(createMockJob({ orderId }))),
		get: vi.fn((id: string) => Promise.resolve(createMockJob({ id }))),
		listForOrder: vi.fn((orderId: string) => Promise.resolve([createMockJob({ orderId })])),
		listEvents: vi.fn((jobId: string) => Promise.resolve([createMockJobEvent({ jobId })])),
		kill: vi.fn((id: string) =>
			Promise.resolve(createMockJob({ id, status: 'killed', reason: 'killed by admin' }))
		),
		listAll: vi.fn().mockResolvedValue([createMockJob()]),
		getDeliverables: vi.fn((jobId: string) => Promise.resolve(createMockDeliverables({ jobId }))),
		authenticateReport: vi.fn((id: string) => Promise.resolve(createMockJob({ id }))),
		rotateReportToken: vi.fn().mockResolvedValue('fresh-token'),
		reportView: vi.fn((job: Job) =>
			Promise.resolve({
				id: job.id,
				status: job.status,
				spec: job.spec,
				budget: job.budget,
				gateWaivers: job.gateWaivers,
				killed: job.status === 'killed',
			})
		),
		reportEvents: vi.fn().mockResolvedValue({ lastEventId: 1 }),
		reportUpdate: vi.fn().mockResolvedValue({ status: 'building', killed: false }),
	}

	app.decorate('jobService', mock)
}

export default fp(mockPlugin, { name: '#internal/jobService' })

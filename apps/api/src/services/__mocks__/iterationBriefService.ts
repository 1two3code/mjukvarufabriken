import fp from 'fastify-plugin'
import { mergeDeep } from '@mf/utils/object'

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import type { PartialDeep } from 'type-fest'
import type { IterationBrief, IterationBriefEntry, IterationBriefSpecSeed } from '@mf/models'

const defaultEntry: IterationBriefEntry = {
	id: 'entry-1',
	kind: 'decision',
	topic: 'data-model',
	body: 'Postgres, one org per tenant',
	author: 'resident',
	createdAt: '2026-09-03T10:00:00.000Z',
}

const defaultBrief: IterationBrief = {
	orgId: 'org-1',
	projectId: 'proj-1',
	title: 'Acme shop',
	entries: [defaultEntry],
	createdAt: '2026-09-01T00:00:00.000Z',
	updatedAt: '2026-09-03T10:00:00.000Z',
}

const defaultSeed: IterationBriefSpecSeed = {
	orgId: 'org-1',
	projectId: 'proj-1',
	title: 'Acme shop',
	spec: { stackConstraints: ['Postgres, one org per tenant'] },
	openQuestions: [],
	decisions: ['Postgres, one org per tenant'],
	context: [],
}

export const createMockIterationBriefEntry = (
	overrides?: PartialDeep<IterationBriefEntry>
): IterationBriefEntry => mergeDeep(defaultEntry, overrides)
export const createMockIterationBrief = (
	overrides?: PartialDeep<IterationBrief>
): IterationBrief => mergeDeep(defaultBrief, overrides)
export const createMockIterationBriefSpecSeed = (
	overrides?: PartialDeep<IterationBriefSpecSeed>
): IterationBriefSpecSeed => mergeDeep(defaultSeed, overrides)

const mockPlugin: FastifyPluginAsync = async app => {
	const mock: FastifyInstance['iterationBriefService'] = {
		get: vi.fn((projectId: string) => Promise.resolve(createMockIterationBrief({ projectId }))),
		list: vi.fn().mockResolvedValue([createMockIterationBrief()]),
		appendEntry: vi.fn((projectId: string) =>
			Promise.resolve(createMockIterationBrief({ projectId }))
		),
		exportSpecSeed: vi.fn((projectId: string) =>
			Promise.resolve(createMockIterationBriefSpecSeed({ projectId }))
		),
	}

	app.decorate('iterationBriefService', mock)
}

export default fp(mockPlugin, { name: '#internal/iterationBriefService' })

import { toIterationBriefSpecSeed, unansweredQuestionIds } from '@mf/models'

import { createMemoryRepositories } from '#/memory.ts'
import { toIterationBrief } from '#/iterationBrief.ts'

import type { IterationBrief, IterationBriefEntry } from '@mf/models'
import type { Repositories } from '#/repositories.ts'

let seq = 0
const entry = (overrides: Partial<IterationBriefEntry> = {}): IterationBriefEntry => ({
	id: `e${++seq}`,
	kind: 'context',
	topic: 'other',
	body: 'a note',
	author: 'resident',
	createdAt: '2026-09-03T10:00:00.000Z',
	...overrides,
})

const brief = (entries: IterationBriefEntry[]): IterationBrief => ({
	orgId: 'org-1',
	projectId: 'proj-1',
	title: 'Acme shop',
	entries,
	createdAt: '2026-09-01T00:00:00.000Z',
	updatedAt: '2026-09-03T00:00:00.000Z',
})

describe('iteration brief model helpers', () => {
	beforeEach(() => {
		seq = 0
	})

	it('unansweredQuestionIds keeps questions no answer refers to', () => {
		const q1 = entry({ id: 'q1', kind: 'question', body: 'Which auth?' })
		const q2 = entry({ id: 'q2', kind: 'question', body: 'How many users?' })
		const a1 = entry({ kind: 'answer', body: 'OIDC', answersEntryId: 'q1' })
		const ids = unansweredQuestionIds(brief([q1, q2, a1]))
		expect([...ids]).toEqual(['q2'])
	})

	it('toIterationBriefSpecSeed projects questions, decisions, context and stack constraints', () => {
		const q1 = entry({ id: 'q1', kind: 'question', topic: 'auth', body: 'Which auth?' })
		const a1 = entry({
			kind: 'answer',
			topic: 'auth',
			body: 'OIDC via Google',
			answersEntryId: 'q1',
		})
		const q2 = entry({ id: 'q2', kind: 'question', topic: 'scale', body: 'Expected load?' })
		const d1 = entry({ kind: 'decision', topic: 'data-model', body: 'Postgres, one org per tenant' })
		const d2 = entry({ kind: 'decision', topic: 'business-rules', body: 'Refunds within 30 days' })
		const c1 = entry({ kind: 'context', topic: 'integrations', body: 'They already use Fortnox' })

		const seed = toIterationBriefSpecSeed(brief([q1, a1, q2, d1, d2, c1]))

		expect(seed).toEqual({
			orgId: 'org-1',
			projectId: 'proj-1',
			title: 'Acme shop',
			// only stack-relevant decisions become spec constraints (data-model here, not business-rules)
			spec: { stackConstraints: ['Postgres, one org per tenant'] },
			openQuestions: ['Expected load?'],
			decisions: ['Postgres, one org per tenant', 'Refunds within 30 days'],
			// Context follows entry order: the answered Q&A (at the question's position) then the note
			context: ['Q: Which auth? — A: OIDC via Google', 'They already use Fortnox'],
		})
	})

	it('toIterationBriefSpecSeed yields an empty spec when no stack decisions exist', () => {
		const d = entry({ kind: 'decision', topic: 'business-rules', body: 'No refunds' })
		expect(toIterationBriefSpecSeed(brief([d])).spec).toEqual({})
	})

	it('toIterationBrief maps a row, dropping a null title', () => {
		expect(
			toIterationBrief({
				org_id: 'org-1',
				project_id: 'proj-1',
				title: null,
				entries: [],
				created_at: new Date('2026-09-01T00:00:00.000Z'),
				updated_at: new Date('2026-09-03T00:00:00.000Z'),
			})
		).toEqual({
			orgId: 'org-1',
			projectId: 'proj-1',
			title: undefined,
			entries: [],
			createdAt: '2026-09-01T00:00:00.000Z',
			updatedAt: '2026-09-03T00:00:00.000Z',
		})
	})
})

describe('iteration brief repository (memory)', () => {
	let repos: Repositories

	beforeEach(() => {
		repos = createMemoryRepositories()
	})

	it('Creates the brief on first append and accumulates entries in order', async () => {
		await repos.iterationBrief.appendEntry(
			'org-1',
			'proj-1',
			entry({ id: 'q1', kind: 'question', body: 'Which auth?' }),
			'Acme shop'
		)
		await repos.iterationBrief.appendEntry(
			'org-1',
			'proj-1',
			entry({ kind: 'answer', body: 'OIDC', answersEntryId: 'q1' }),
			'ignored on update'
		)

		const stored = await repos.iterationBrief.get('org-1', 'proj-1')
		expect(stored?.title).toBe('Acme shop')
		expect(stored?.entries.map(item => item.body)).toEqual(['Which auth?', 'OIDC'])
	})

	it('Scopes get by org and project and returns undefined for an unknown project', async () => {
		await repos.iterationBrief.appendEntry('org-1', 'proj-1', entry())
		expect(await repos.iterationBrief.get('org-1', 'other')).toBeUndefined()
		expect(await repos.iterationBrief.get('org-2', 'proj-1')).toBeUndefined()
	})

	it('Lists an org brief set most-recently-updated first, scoped to the org', async () => {
		await repos.iterationBrief.appendEntry('org-1', 'a', entry())
		await repos.iterationBrief.appendEntry('org-1', 'b', entry())
		await repos.iterationBrief.appendEntry('org-2', 'c', entry())
		// Touch 'a' again so it is unambiguously the most recently updated of the org
		await repos.iterationBrief.appendEntry('org-1', 'a', entry())

		const org1 = await repos.iterationBrief.list('org-1')
		expect(org1[0]?.projectId).toBe('a')
		expect(org1.map(item => item.projectId).toSorted()).toEqual(['a', 'b'])
		expect(await repos.iterationBrief.list()).toHaveLength(3)
	})
})

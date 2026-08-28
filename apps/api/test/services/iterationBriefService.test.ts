import { EntityNotFound } from '#/lib/entityError.ts'

import type { FastifyInstance } from 'fastify'
import type { BackendSession, NewIterationBriefEntry } from '@mf/models'

const session: BackendSession = { userId: 'user-1', role: 'user', orgId: 'org-1' }
const otherOrg: BackendSession = { userId: 'user-2', role: 'user', orgId: 'org-2' }
const admin: BackendSession = { userId: 'admin-1', role: 'admin', orgId: 'org-9' }

const entry = (overrides: Partial<NewIterationBriefEntry> = {}): NewIterationBriefEntry => ({
	kind: 'context',
	topic: 'other',
	body: 'a note',
	author: 'resident',
	...overrides,
})

describe('Iteration brief service', () => {
	let app: FastifyInstance

	beforeEach(async () => {
		app = await createTestApp({ skipMock: '#/services/iterationBriefService.ts' })
	})

	it('Creates the brief on first append, mints id and timestamp, and accumulates', async () => {
		await app.iterationBriefService.appendEntry(
			'proj-1',
			entry({ kind: 'question', topic: 'auth', body: 'Which auth?' }),
			session
		)
		const brief = await app.iterationBriefService.appendEntry(
			'proj-1',
			entry({ kind: 'decision', topic: 'data-model', body: 'Postgres' }),
			session
		)

		expect(brief.orgId).toBe('org-1')
		expect(brief.projectId).toBe('proj-1')
		expect(brief.entries).toHaveLength(2)
		expect(brief.entries[0]).toMatchObject({ kind: 'question', body: 'Which auth?' })
		expect(brief.entries[0]?.id).toEqual(expect.any(String))
		expect(brief.entries[0]?.createdAt).toEqual(expect.any(String))
	})

	it('Scopes reads to the session org — another org cannot see the brief', async () => {
		await app.iterationBriefService.appendEntry('proj-1', entry(), session)

		await expect(app.iterationBriefService.get('proj-1', otherOrg)).rejects.toBeInstanceOf(
			EntityNotFound
		)
		await expect(app.iterationBriefService.get('missing', session)).rejects.toBeInstanceOf(
			EntityNotFound
		)
	})

	it('Lists only the session org briefs (admins list every org)', async () => {
		await app.iterationBriefService.appendEntry('proj-1', entry(), session)
		await app.iterationBriefService.appendEntry('proj-2', entry(), otherOrg)

		expect(await app.iterationBriefService.list(session)).toHaveLength(1)
		expect(await app.iterationBriefService.list(admin)).toHaveLength(2)
	})

	it('Exports the brief as a spec-engine seed', async () => {
		await app.iterationBriefService.appendEntry(
			'proj-1',
			entry({ kind: 'question', topic: 'scale', body: 'Expected load?' }),
			session
		)
		await app.iterationBriefService.appendEntry(
			'proj-1',
			entry({ kind: 'decision', topic: 'integrations', body: 'Use Fortnox API' }),
			session
		)

		const seed = await app.iterationBriefService.exportSpecSeed('proj-1', session)

		expect(seed).toMatchObject({
			orgId: 'org-1',
			projectId: 'proj-1',
			spec: { stackConstraints: ['Use Fortnox API'] },
			openQuestions: ['Expected load?'],
			decisions: ['Use Fortnox API'],
		})
	})

	it('Rejects exporting a seed for a project without a brief', async () => {
		await expect(
			app.iterationBriefService.exportSpecSeed('missing', session)
		).rejects.toBeInstanceOf(EntityNotFound)
	})
})

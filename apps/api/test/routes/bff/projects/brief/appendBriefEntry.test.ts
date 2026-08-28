import appendBriefEntry from '#/routes/bff/projects/brief/appendBriefEntry.ts'
import { createMockIterationBrief } from '#/services/__mocks__/iterationBriefService.ts'

import type { FastifyInstance } from 'fastify'

const session = { userId: 'user-1', role: 'user', orgId: 'org-1' }

describe('POST /bff/projects/:projectId/brief/entries route', () => {
	let app: FastifyInstance

	const url = '/bff/projects/proj-1/brief/entries'

	beforeEach(async () => {
		app = await createTestApp()
		app.register(appendBriefEntry)
	})

	it('Appends an entry and defaults topic and author', async () => {
		const payload = { kind: 'question', body: 'Which auth provider?' }

		const response = await app.inject({ method: 'POST', url, payload })

		expect(response.statusCode).toBe(201)
		expect(app.iterationBriefService.appendEntry).toHaveBeenCalledWith(
			'proj-1',
			{ kind: 'question', body: 'Which auth provider?', topic: 'other', author: 'resident' },
			session
		)
		expect(response.json()).toEqual(createMockIterationBrief({ projectId: 'proj-1' }))
	})

	it('Rejects an unknown kind and unknown fields with 400', async () => {
		const badKind = await app.inject({ method: 'POST', url, payload: { kind: 'note', body: 'x' } })
		const unknown = await app.inject({
			method: 'POST',
			url,
			payload: { kind: 'context', body: 'x', extra: 1 },
		})

		expect(badKind.statusCode).toBe(400)
		expect(unknown.statusCode).toBe(400)
	})

	it('Rejects answersEntryId on a non-answer entry with 400', async () => {
		const response = await app.inject({
			method: 'POST',
			url,
			payload: { kind: 'decision', body: 'x', answersEntryId: 'q1' },
		})

		expect(response.statusCode).toBe(400)
	})

	it('Handles server error with 500 response', async () => {
		vi.spyOn(app.iterationBriefService, 'appendEntry').mockRejectedValue(new Error('Fail'))

		const response = await app.inject({
			method: 'POST',
			url,
			payload: { kind: 'context', body: 'x' },
		})

		expect(response.statusCode).toBe(500)
	})
})

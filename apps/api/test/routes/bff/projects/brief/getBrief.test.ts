import { EntityNotFound } from '#/lib/entityError.ts'
import getBrief from '#/routes/bff/projects/brief/getBrief.ts'
import { createMockIterationBrief } from '#/services/__mocks__/iterationBriefService.ts'

import type { FastifyInstance } from 'fastify'

const session = { userId: 'user-1', role: 'user', orgId: 'org-1' }

describe('GET /bff/projects/:projectId/brief route', () => {
	let app: FastifyInstance

	const url = '/bff/projects/proj-1/brief'

	beforeEach(async () => {
		app = await createTestApp()
		app.register(getBrief)
	})

	it('Returns the org project brief', async () => {
		const response = await app.inject({ url })

		expect(app.iterationBriefService.get).toHaveBeenCalledWith('proj-1', session)
		expect(response.statusCode).toBe(200)
		expect(response.json()).toEqual(createMockIterationBrief({ projectId: 'proj-1' }))
	})

	it('Handles a project without a brief with 404', async () => {
		vi.spyOn(app.iterationBriefService, 'get').mockRejectedValue(
			new EntityNotFound('iterationBrief')
		)

		const response = await app.inject({ url })

		expect(response.statusCode).toBe(404)
	})

	it('Handles server error with 500 response', async () => {
		vi.spyOn(app.iterationBriefService, 'get').mockRejectedValue(new Error('Fail'))

		const response = await app.inject({ url })

		expect(response.statusCode).toBe(500)
	})
})

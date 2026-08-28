import { EntityNotFound } from '#/lib/entityError.ts'
import getBriefSpecInput from '#/routes/bff/projects/brief/getBriefSpecInput.ts'
import { createMockIterationBriefSpecSeed } from '#/services/__mocks__/iterationBriefService.ts'

import type { FastifyInstance } from 'fastify'

const session = { userId: 'user-1', role: 'user', orgId: 'org-1' }

describe('GET /bff/projects/:projectId/brief/spec-input route', () => {
	let app: FastifyInstance

	const url = '/bff/projects/proj-1/brief/spec-input'

	beforeEach(async () => {
		app = await createTestApp()
		app.register(getBriefSpecInput)
	})

	it('Returns the spec-engine seed derived from the brief', async () => {
		const response = await app.inject({ url })

		expect(app.iterationBriefService.exportSpecSeed).toHaveBeenCalledWith('proj-1', session)
		expect(response.statusCode).toBe(200)
		expect(response.json()).toEqual(createMockIterationBriefSpecSeed({ projectId: 'proj-1' }))
	})

	it('Handles a project without a brief with 404', async () => {
		vi.spyOn(app.iterationBriefService, 'exportSpecSeed').mockRejectedValue(
			new EntityNotFound('iterationBrief')
		)

		const response = await app.inject({ url })

		expect(response.statusCode).toBe(404)
	})

	it('Handles server error with 500 response', async () => {
		vi.spyOn(app.iterationBriefService, 'exportSpecSeed').mockRejectedValue(new Error('Fail'))

		const response = await app.inject({ url })

		expect(response.statusCode).toBe(500)
	})
})

import { EntityNotFound } from '#/lib/entityError.ts'
import { createMockJob } from '#/plugins/__mocks__/db.ts'
import getJob from '#/routes/bff/jobs/getJob.ts'

import type { FastifyInstance } from 'fastify'

const session = { userId: 'user-1', role: 'user', orgId: 'org-1' }

describe('GET /bff/jobs/:jobId route', () => {
	let app: FastifyInstance

	const url = '/bff/jobs/job-1'

	beforeEach(async () => {
		app = await createTestApp()
		app.register(getJob)
	})

	it('Returns the job by id', async () => {
		// Arrange
		// Act
		const response = await app.inject({ url })

		// Assert
		expect(app.jobService.get).toHaveBeenCalledWith('job-1', session)
		expect(response.statusCode).toBe(200)
		expect(response.json()).toEqual(createMockJob({ id: 'job-1' }))
	})

	it('Handles unknown job with 404 response', async () => {
		// Arrange
		vi.spyOn(app.jobService, 'get').mockRejectedValue(new EntityNotFound('job', 'job-1'))

		// Act
		const response = await app.inject({ url })

		// Assert
		expect(response.statusCode).toBe(404)
	})

	it('Handles server error with 500 response', async () => {
		// Arrange
		vi.spyOn(app.jobService, 'get').mockRejectedValue(new Error('Fail'))

		// Act
		const response = await app.inject({ url })

		// Assert
		expect(response.statusCode).toBe(500)
	})
})

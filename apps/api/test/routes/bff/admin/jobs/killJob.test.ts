import { EntityNotFound } from '#/lib/entityError.ts'
import { createMockJob } from '#/plugins/__mocks__/db.ts'
import killJob from '#/routes/bff/admin/jobs/killJob.ts'

import type { FastifyInstance } from 'fastify'

describe('POST /bff/admin/jobs/:jobId/kill route', () => {
	let app: FastifyInstance

	const url = '/bff/admin/jobs/job-1/kill'

	beforeEach(async () => {
		app = await createTestApp()
		app.register(killJob)
	})

	it('Kills the job and returns it', async () => {
		// Arrange
		// Act
		const response = await app.inject({ method: 'POST', url })

		// Assert
		expect(app.jobService.kill).toHaveBeenCalledWith('job-1')
		expect(response.statusCode).toBe(200)
		expect(response.json()).toEqual(
			createMockJob({ id: 'job-1', status: 'killed', reason: 'killed by admin' })
		)
	})

	it('Handles unknown job with 404 response', async () => {
		// Arrange
		vi.spyOn(app.jobService, 'kill').mockRejectedValue(new EntityNotFound('job', 'job-1'))

		// Act
		const response = await app.inject({ method: 'POST', url })

		// Assert
		expect(response.statusCode).toBe(404)
	})
})

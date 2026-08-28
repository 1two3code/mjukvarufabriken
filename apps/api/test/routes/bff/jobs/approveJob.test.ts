import { EntityNotFound } from '#/lib/entityError.ts'
import { createMockJob } from '#/plugins/__mocks__/db.ts'
import approveJob from '#/routes/bff/jobs/approveJob.ts'
import { JobNotAwaitingApproval } from '#/services/jobService.ts'

import type { FastifyInstance } from 'fastify'

describe('POST /bff/jobs/:jobId/approve route', () => {
	let app: FastifyInstance

	const url = '/bff/jobs/job-1/approve'

	beforeEach(async () => {
		app = await createTestApp()
		app.register(approveJob)
	})

	it('Approves a held job and returns it (the container resumes into delivery)', async () => {
		// Arrange
		// Act
		const response = await app.inject({ method: 'POST', url })

		// Assert
		expect(app.jobService.approve).toHaveBeenCalledWith('job-1', expect.anything())
		expect(response.statusCode).toBe(200)
		expect(response.json()).toEqual(
			createMockJob({ id: 'job-1', awaitingApproval: true, approved: true })
		)
	})

	it('Responds 409 when the job is not awaiting approval', async () => {
		// Arrange
		vi.spyOn(app.jobService, 'approve').mockRejectedValue(new JobNotAwaitingApproval('job-1'))

		// Act
		const response = await app.inject({ method: 'POST', url })

		// Assert
		expect(response.statusCode).toBe(409)
	})

	it('Handles unknown job with 404 response', async () => {
		// Arrange
		vi.spyOn(app.jobService, 'approve').mockRejectedValue(new EntityNotFound('job', 'job-1'))

		// Act
		const response = await app.inject({ method: 'POST', url })

		// Assert
		expect(response.statusCode).toBe(404)
	})
})

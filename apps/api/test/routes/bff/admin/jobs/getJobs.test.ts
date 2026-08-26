import { createMockJob } from '#/plugins/__mocks__/db.ts'
import getJobs from '#/routes/bff/admin/jobs/getJobs.ts'

import type { FastifyInstance } from 'fastify'

describe('GET /bff/admin/jobs route', () => {
	let app: FastifyInstance

	const url = '/bff/admin/jobs'

	beforeEach(async () => {
		app = await createTestApp()
		app.register(getJobs)
	})

	it('Returns every job for admins', async () => {
		// Arrange
		// Act
		const response = await app.inject({ url })

		// Assert
		expect(response.statusCode).toBe(200)
		expect(response.json()).toEqual([createMockJob()])
	})

	it('Handles server error with 500 response', async () => {
		// Arrange
		vi.spyOn(app.jobService, 'listAll').mockRejectedValue(new Error('Fail'))

		// Act
		const response = await app.inject({ url })

		// Assert
		expect(response.statusCode).toBe(500)
	})
})

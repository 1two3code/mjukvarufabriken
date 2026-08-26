import { EntityNotFound } from '#/lib/entityError.ts'
import { createMockJob } from '#/plugins/__mocks__/db.ts'
import postJobToken from '#/routes/internal/jobs/postJobToken.ts'
import { ReportUnauthorized } from '#/services/jobService.ts'

import type { FastifyInstance } from 'fastify'

describe('POST /internal/jobs/:jobId/token route', () => {
	let app: FastifyInstance

	const url = '/internal/jobs/job-1/token'
	const headers = { authorization: 'Bearer boot-token' }

	beforeEach(async () => {
		app = await createTestApp()
		app.register(postJobToken)
	})

	it('Exchanges the bootstrap token for a fresh one', async () => {
		// Arrange
		// Act
		const response = await app.inject({ method: 'POST', url, headers })

		// Assert
		expect(app.jobService.authenticateReport).toHaveBeenCalledWith('job-1', 'boot-token')
		expect(app.jobService.rotateReportToken).toHaveBeenCalledWith(createMockJob({ id: 'job-1' }))
		expect(response.statusCode).toBe(200)
		expect(response.json()).toEqual({ token: 'fresh-token' })
	})

	it('Responds 401 to a wrong (or already exchanged) token', async () => {
		// Arrange
		vi.spyOn(app.jobService, 'authenticateReport').mockRejectedValue(new ReportUnauthorized())

		// Act
		const response = await app.inject({ method: 'POST', url, headers })

		// Assert
		expect(response.statusCode).toBe(401)
		expect(app.jobService.rotateReportToken).not.toHaveBeenCalled()
	})

	it("Responds 404 to another job's token", async () => {
		// Arrange
		vi.spyOn(app.jobService, 'authenticateReport').mockRejectedValue(
			new EntityNotFound('job', 'job-1')
		)

		// Act
		const response = await app.inject({ method: 'POST', url, headers })

		// Assert
		expect(response.statusCode).toBe(404)
	})
})

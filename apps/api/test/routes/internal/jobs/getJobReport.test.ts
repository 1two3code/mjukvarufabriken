import { EntityNotFound } from '#/lib/entityError.ts'
import { createMockJob } from '#/plugins/__mocks__/db.ts'
import getJobReport from '#/routes/internal/jobs/getJobReport.ts'
import { ReportUnauthorized } from '#/services/jobService.ts'

import type { FastifyInstance } from 'fastify'

describe('GET /internal/jobs/:jobId route', () => {
	let app: FastifyInstance

	const url = '/internal/jobs/job-1'
	const headers = { authorization: 'Bearer job-token' }

	beforeEach(async () => {
		app = await createTestApp()
		app.register(getJobReport)
	})

	it("Returns the job's report view for its token", async () => {
		// Arrange
		// Act
		const response = await app.inject({ url, headers })

		// Assert
		expect(app.jobService.authenticateReport).toHaveBeenCalledWith('job-1', 'job-token')
		expect(response.statusCode).toBe(200)
		expect(response.json()).toEqual({
			id: 'job-1',
			status: 'queued',
			spec: createMockJob().spec,
			budget: createMockJob().budget,
			killed: false,
		})
	})

	it('Responds 401 to a wrong or missing token', async () => {
		// Arrange
		vi.spyOn(app.jobService, 'authenticateReport').mockRejectedValue(new ReportUnauthorized())

		// Act
		const withWrong = await app.inject({ url, headers: { authorization: 'Bearer wrong' } })
		const without = await app.inject({ url })

		// Assert
		expect(withWrong.statusCode).toBe(401)
		expect(without.statusCode).toBe(401)
		expect(app.jobService.authenticateReport).toHaveBeenLastCalledWith('job-1', undefined)
	})

	it("Responds 404 to another job's token", async () => {
		// Arrange
		vi.spyOn(app.jobService, 'authenticateReport').mockRejectedValue(
			new EntityNotFound('job', 'job-1')
		)

		// Act
		const response = await app.inject({ url, headers })

		// Assert
		expect(response.statusCode).toBe(404)
	})
})

import { EntityNotFound } from '#/lib/entityError.ts'
import { createMockJob } from '#/plugins/__mocks__/db.ts'
import patchJob from '#/routes/internal/jobs/patchJob.ts'
import { ReportUnauthorized } from '#/services/jobService.ts'

import type { FastifyInstance } from 'fastify'

describe('PATCH /internal/jobs/:jobId route', () => {
	let app: FastifyInstance

	const url = '/internal/jobs/job-1'
	const headers = { authorization: 'Bearer job-token' }
	const update = { status: 'building', tokensUsed: 1234, startedAt: '2026-08-26T12:00:00.000Z' }

	beforeEach(async () => {
		app = await createTestApp()
		app.register(patchJob)
	})

	it('Applies the update and returns the stored status + kill flag', async () => {
		// Arrange
		// Act
		const response = await app.inject({ method: 'PATCH', url, headers, payload: update })

		// Assert
		expect(app.jobService.reportUpdate).toHaveBeenCalledWith(createMockJob({ id: 'job-1' }), update)
		expect(response.statusCode).toBe(200)
		expect(response.json()).toEqual({ status: 'building', killed: false })
	})

	it('Reports the kill to the container when the row is killed', async () => {
		// Arrange
		vi.spyOn(app.jobService, 'reportUpdate').mockResolvedValue({ status: 'killed', killed: true })

		// Act
		const response = await app.inject({ method: 'PATCH', url, headers, payload: update })

		// Assert
		expect(response.json()).toEqual({ status: 'killed', killed: true })
	})

	it('Rejects re-queueing, unknown fields and a bad timestamp with 400', async () => {
		// Arrange
		// Act
		const requeue = await app.inject({
			method: 'PATCH',
			url,
			headers,
			payload: { status: 'queued' },
		})
		const unknown = await app.inject({ method: 'PATCH', url, headers, payload: { orgId: 'x' } })
		const badDate = await app.inject({
			method: 'PATCH',
			url,
			headers,
			payload: { finishedAt: 'yesterday' },
		})

		// Assert
		expect(requeue.statusCode).toBe(400)
		expect(unknown.statusCode).toBe(400)
		expect(badDate.statusCode).toBe(400)
		expect(app.jobService.reportUpdate).not.toHaveBeenCalled()
	})

	it('Responds 401 to a wrong token', async () => {
		// Arrange
		vi.spyOn(app.jobService, 'authenticateReport').mockRejectedValue(new ReportUnauthorized())

		// Act
		const response = await app.inject({ method: 'PATCH', url, headers, payload: update })

		// Assert
		expect(response.statusCode).toBe(401)
	})

	it("Responds 404 to another job's token", async () => {
		// Arrange
		vi.spyOn(app.jobService, 'authenticateReport').mockRejectedValue(
			new EntityNotFound('job', 'job-1')
		)

		// Act
		const response = await app.inject({ method: 'PATCH', url, headers, payload: update })

		// Assert
		expect(response.statusCode).toBe(404)
	})
})

import { EntityNotFound } from '#/lib/entityError.ts'
import { createMockJob } from '#/plugins/__mocks__/db.ts'
import postJobEvents from '#/routes/internal/jobs/postJobEvents.ts'
import { MalformedGateReport, ReportUnauthorized } from '#/services/jobService.ts'

import type { FastifyInstance } from 'fastify'

describe('POST /internal/jobs/:jobId/events route', () => {
	let app: FastifyInstance

	const url = '/internal/jobs/job-1/events'
	const headers = { authorization: 'Bearer job-token' }
	const events = [
		{ type: 'started', payload: { budget: { maxTokens: 1 } } },
		{ type: 'log', payload: { message: 'hi' } },
	]

	beforeEach(async () => {
		app = await createTestApp()
		app.register(postJobEvents)
	})

	it('Stores the batch and returns the last event id', async () => {
		// Arrange
		// Act
		const response = await app.inject({ method: 'POST', url, headers, payload: { events } })

		// Assert
		expect(app.jobService.authenticateReport).toHaveBeenCalledWith('job-1', 'job-token')
		expect(app.jobService.reportEvents).toHaveBeenCalledWith(createMockJob({ id: 'job-1' }), events)
		expect(response.statusCode).toBe(200)
		expect(response.json()).toEqual({ lastEventId: 1 })
	})

	it('Passes event numbers through and rejects a malformed gate report with 400', async () => {
		// Arrange
		const numbered = [{ type: 'gate', payload: { name: 'verify' }, seq: 3 }]
		vi.spyOn(app.jobService, 'reportEvents').mockRejectedValue(new MalformedGateReport('job-1'))

		// Act
		const response = await app.inject({
			method: 'POST',
			url,
			headers,
			payload: { events: numbered },
		})

		// Assert
		expect(app.jobService.reportEvents).toHaveBeenCalledWith(
			createMockJob({ id: 'job-1' }),
			numbered
		)
		expect(response.statusCode).toBe(400)
	})

	it('Rejects an empty batch or an unknown event type with 400', async () => {
		// Arrange
		// Act
		const empty = await app.inject({ method: 'POST', url, headers, payload: { events: [] } })
		const unknown = await app.inject({
			method: 'POST',
			url,
			headers,
			payload: { events: [{ type: 'rm-rf', payload: {} }] },
		})

		// Assert
		expect(empty.statusCode).toBe(400)
		expect(unknown.statusCode).toBe(400)
		expect(app.jobService.reportEvents).not.toHaveBeenCalled()
	})

	it('Responds 401 to a wrong token', async () => {
		// Arrange
		vi.spyOn(app.jobService, 'authenticateReport').mockRejectedValue(new ReportUnauthorized())

		// Act
		const response = await app.inject({ method: 'POST', url, headers, payload: { events } })

		// Assert
		expect(response.statusCode).toBe(401)
		expect(app.jobService.reportEvents).not.toHaveBeenCalled()
	})

	it("Responds 404 to another job's token", async () => {
		// Arrange
		vi.spyOn(app.jobService, 'authenticateReport').mockRejectedValue(
			new EntityNotFound('job', 'job-1')
		)

		// Act
		const response = await app.inject({ method: 'POST', url, headers, payload: { events } })

		// Assert
		expect(response.statusCode).toBe(404)
	})
})

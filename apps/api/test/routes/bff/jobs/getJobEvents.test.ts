import { EntityNotFound } from '#/lib/entityError.ts'
import { createMockJobEvent } from '#/plugins/__mocks__/db.ts'
import getJobEvents from '#/routes/bff/jobs/getJobEvents.ts'

import type { FastifyInstance } from 'fastify'

const session = { userId: 'user-1', role: 'user', orgId: 'org-1' }

describe('GET /bff/jobs/:jobId/events route', () => {
	let app: FastifyInstance

	const url = '/bff/jobs/job-1/events'

	beforeEach(async () => {
		app = await createTestApp()
		app.register(getJobEvents)
	})

	it('Returns events from the start by default', async () => {
		// Arrange
		// Act
		const response = await app.inject({ url })

		// Assert
		expect(app.jobService.listEvents).toHaveBeenCalledWith('job-1', 0, session)
		expect(response.statusCode).toBe(200)
		expect(response.json()).toEqual([createMockJobEvent({ jobId: 'job-1' })])
	})

	it('Passes the after cursor', async () => {
		// Arrange
		// Act
		const response = await app.inject({ url: `${url}?after=17` })

		// Assert
		expect(response.statusCode).toBe(200)
		expect(app.jobService.listEvents).toHaveBeenCalledWith('job-1', 17, session)
	})

	it('Rejects a negative or non-numeric cursor with 400', async () => {
		// Arrange
		// Act
		const negative = await app.inject({ url: `${url}?after=-1` })
		const text = await app.inject({ url: `${url}?after=abc` })

		// Assert
		expect(negative.statusCode).toBe(400)
		expect(text.statusCode).toBe(400)
	})

	it('Handles unknown job with 404 response', async () => {
		// Arrange
		vi.spyOn(app.jobService, 'listEvents').mockRejectedValue(new EntityNotFound('job', 'job-1'))

		// Act
		const response = await app.inject({ url })

		// Assert
		expect(response.statusCode).toBe(404)
	})
})

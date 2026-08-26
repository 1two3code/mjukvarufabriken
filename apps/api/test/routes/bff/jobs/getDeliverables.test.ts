import { EntityNotFound } from '#/lib/entityError.ts'
import getDeliverables from '#/routes/bff/jobs/getDeliverables.ts'
import { createMockDeliverables } from '#/services/__mocks__/jobService.ts'

import type { FastifyInstance } from 'fastify'

const session = { userId: 'user-1', role: 'user', orgId: 'org-1' }

describe('GET /bff/jobs/:jobId/deliverables route', () => {
	let app: FastifyInstance

	const url = '/bff/jobs/job-1/deliverables'

	beforeEach(async () => {
		app = await createTestApp()
		app.register(getDeliverables)
	})

	it('Returns the deliverable record with presigned download links', async () => {
		// Arrange
		// Act
		const response = await app.inject({ url })

		// Assert
		expect(app.jobService.getDeliverables).toHaveBeenCalledWith('job-1', session)
		expect(response.statusCode).toBe(200)
		expect(response.json()).toEqual(createMockDeliverables({ jobId: 'job-1' }))
		expect(response.json().files[0].url).toMatch(/X-Amz-Signature/)
	})

	it('Handles a job without deliverables (or unknown / other org) with 404', async () => {
		// Arrange
		vi.spyOn(app.jobService, 'getDeliverables').mockRejectedValue(
			new EntityNotFound('deliverables', 'job-1')
		)

		// Act
		const response = await app.inject({ url })

		// Assert
		expect(response.statusCode).toBe(404)
	})

	it('Answers 503 when the api has no artifacts bucket', async () => {
		// Arrange
		app.s3.configured = false

		// Act
		const response = await app.inject({ url })

		// Assert
		expect(response.statusCode).toBe(503)
		expect(app.jobService.getDeliverables).not.toHaveBeenCalled()
	})

	it('Handles server error with 500 response', async () => {
		// Arrange
		vi.spyOn(app.jobService, 'getDeliverables').mockRejectedValue(new Error('Fail'))

		// Act
		const response = await app.inject({ url })

		// Assert
		expect(response.statusCode).toBe(500)
	})
})

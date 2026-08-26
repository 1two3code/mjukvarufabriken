import { createMockJob } from '#/plugins/__mocks__/db.ts'
import startJob from '#/routes/bff/orders/jobs/startJob.ts'
import { JobAlreadyActive, SpecNotFrozen } from '#/services/jobService.ts'

import type { FastifyInstance } from 'fastify'

const session = { userId: 'user-1', role: 'user', orgId: 'org-1' }

describe('POST /bff/orders/:orderId/jobs route', () => {
	let app: FastifyInstance

	const url = '/bff/orders/order-1/jobs'

	beforeEach(async () => {
		app = await createTestApp()
		app.register(startJob)
	})

	it('Starts a job and returns it with 201', async () => {
		// Arrange
		const job = createMockJob({ orderId: 'order-1' })
		vi.spyOn(app.jobService, 'start').mockResolvedValue(job)

		// Act
		const response = await app.inject({ method: 'POST', url })

		// Assert
		expect(app.jobService.start).toHaveBeenCalledWith('order-1', session)
		expect(response.statusCode).toBe(201)
		expect(response.json()).toEqual(job)
	})

	it('Responds 409 specNotFrozen when the spec is not frozen', async () => {
		// Arrange
		vi.spyOn(app.jobService, 'start').mockRejectedValue(new SpecNotFrozen('order-1'))

		// Act
		const response = await app.inject({ method: 'POST', url })

		// Assert
		expect(response.statusCode).toBe(409)
		expect(response.json().error.code).toBe('specNotFrozen')
	})

	it('Responds 409 jobAlreadyActive when a job is already running', async () => {
		// Arrange
		vi.spyOn(app.jobService, 'start').mockRejectedValue(new JobAlreadyActive('order-1'))

		// Act
		const response = await app.inject({ method: 'POST', url })

		// Assert
		expect(response.statusCode).toBe(409)
		expect(response.json().error.code).toBe('jobAlreadyActive')
	})

	it('Handles server error with 500 response', async () => {
		// Arrange
		vi.spyOn(app.jobService, 'start').mockRejectedValue(new Error('Fail'))

		// Act
		const response = await app.inject({ method: 'POST', url })

		// Assert
		expect(response.statusCode).toBe(500)
	})
})

import { EntityNotFound } from '#/lib/entityError.ts'
import { createMockJob } from '#/plugins/__mocks__/db.ts'
import redeliverJob from '#/routes/bff/orders/jobs/redeliverJob.ts'
import { createMockOrder } from '#/services/__mocks__/orderService.ts'
import { JobAlreadyActive, NothingToRedeliver } from '#/services/jobService.ts'

import type { FastifyInstance } from 'fastify'

const session = { userId: 'user-1', role: 'user', orgId: 'org-1' }

describe('POST /bff/orders/:orderId/jobs/redeliver route', () => {
	let app: FastifyInstance

	const url = '/bff/orders/order-1/jobs/redeliver'

	beforeEach(async () => {
		app = await createTestApp()
		app.register(redeliverJob)
		vi.spyOn(app.orderService, 'get').mockResolvedValue(
			createMockOrder({ id: 'order-1', status: 'delivered' })
		)
	})

	it('Starts a redelivery of the order and returns 201', async () => {
		// Arrange
		const job = createMockJob({ orderId: 'order-1', mode: 'redeliver', sourceJobId: 'job-0' })
		vi.spyOn(app.jobService, 'redeliver').mockResolvedValue(job)

		// Act
		const response = await app.inject({ method: 'POST', url })

		// Assert
		expect(app.orderService.get).toHaveBeenCalledWith('order-1', session)
		expect(app.jobService.redeliver).toHaveBeenCalledWith('order-1', session)
		expect(response.statusCode).toBe(201)
		expect(response.json()).toEqual(job)
	})

	it('Is 404 for an order the caller cannot see', async () => {
		vi.spyOn(app.orderService, 'get').mockRejectedValueOnce(new EntityNotFound('order', 'order-1'))

		const response = await app.inject({ method: 'POST', url })

		expect(response.statusCode).toBe(404)
		expect(app.jobService.redeliver).not.toHaveBeenCalled()
	})

	it('Is 409 nothingToRedeliver when no job of the order delivered a repository', async () => {
		vi.spyOn(app.jobService, 'redeliver').mockRejectedValueOnce(new NothingToRedeliver('order-1'))

		const response = await app.inject({ method: 'POST', url })

		expect(response.statusCode).toBe(409)
		expect(response.json().error.code).toBe('nothingToRedeliver')
	})

	it('Is 409 jobAlreadyActive while a build or redelivery is running', async () => {
		vi.spyOn(app.jobService, 'redeliver').mockRejectedValueOnce(new JobAlreadyActive('order-1'))

		const response = await app.inject({ method: 'POST', url })

		expect(response.statusCode).toBe(409)
		expect(response.json().error.code).toBe('jobAlreadyActive')
	})
})

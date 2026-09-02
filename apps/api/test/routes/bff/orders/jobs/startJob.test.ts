import { EntityNotFound } from '#/lib/entityError.ts'
import { createMockJob } from '#/plugins/__mocks__/db.ts'
import startJob from '#/routes/bff/orders/jobs/startJob.ts'
import { createMockOrder } from '#/services/__mocks__/orderService.ts'
import { JobAlreadyActive, SpecNotFrozen } from '#/services/jobService.ts'

import type { FastifyInstance } from 'fastify'

const session = { userId: 'user-1', role: 'user', orgId: 'org-1' }

describe('POST /bff/orders/:orderId/jobs route', () => {
	let app: FastifyInstance

	const url = '/bff/orders/order-1/jobs'

	beforeEach(async () => {
		app = await createTestApp()
		app.register(startJob)
		vi.spyOn(app.orderService, 'get').mockResolvedValue(
			createMockOrder({ id: 'order-1', status: 'deposit_paid' })
		)
	})

	it('Starts a job once the deposit is paid, marks the order building and returns 201', async () => {
		// Arrange
		const job = createMockJob({ orderId: 'order-1' })
		vi.spyOn(app.jobService, 'start').mockResolvedValue(job)

		// Act
		const response = await app.inject({ method: 'POST', url })

		// Assert
		expect(app.orderService.get).toHaveBeenCalledWith('order-1', session)
		expect(app.jobService.start).toHaveBeenCalledWith('order-1', session)
		expect(app.orderService.transition).toHaveBeenCalledWith('order-1', 'building')
		expect(response.statusCode).toBe(201)
		expect(response.json()).toEqual(job)
	})

	it('Restarts a build on a building order without another transition', async () => {
		vi.spyOn(app.orderService, 'get').mockResolvedValue(
			createMockOrder({ id: 'order-1', status: 'building' })
		)

		const response = await app.inject({ method: 'POST', url })

		expect(response.statusCode).toBe(201)
		expect(app.orderService.transition).not.toHaveBeenCalled()
	})

	it('Responds 409 depositNotPaid before the deposit (customers)', async () => {
		// Arrange
		vi.spyOn(app.orderService, 'get').mockResolvedValue(
			createMockOrder({ id: 'order-1', status: 'frozen' })
		)

		// Act
		const response = await app.inject({ method: 'POST', url })

		// Assert
		expect(response.statusCode).toBe(409)
		expect(response.json().error.code).toBe('depositNotPaid')
		expect(app.jobService.start).not.toHaveBeenCalled()
	})

	it('Responds 409 demoAwaitingApproval for a paid demo an admin has not approved (customers)', async () => {
		// Arrange
		vi.spyOn(app.orderService, 'get').mockResolvedValue(
			createMockOrder({ id: 'order-1', kind: 'demo', status: 'deposit_paid' })
		)

		// Act
		const response = await app.inject({ method: 'POST', url })

		// Assert
		expect(response.statusCode).toBe(409)
		expect(response.json().error.code).toBe('demoAwaitingApproval')
		expect(app.jobService.start).not.toHaveBeenCalled()
	})

	it('Lets a customer restart an approved demo (a failed build) like any paid order', async () => {
		vi.spyOn(app.orderService, 'get').mockResolvedValue(
			createMockOrder({
				id: 'order-1',
				kind: 'demo',
				status: 'deposit_paid',
				buildApprovedAt: '2026-09-02T10:00:00.000Z',
			})
		)

		const response = await app.inject({ method: 'POST', url })

		expect(response.statusCode).toBe(201)
		expect(app.jobService.start).toHaveBeenCalledWith('order-1', session)
	})

	it('Lets an admin start a build on a frozen order and marks it building', async () => {
		// Arrange: the admin override — the auth mock's session is patched to the admin role
		app = await createTestApp()
		app.addHook('onRequest', async request => {
			request.session = { ...request.session, role: 'admin' }
		})
		app.register(startJob)
		vi.spyOn(app.orderService, 'get').mockResolvedValue(
			createMockOrder({ id: 'order-1', status: 'frozen' })
		)
		const job = createMockJob({ orderId: 'order-1' })
		vi.spyOn(app.jobService, 'start').mockResolvedValue(job)

		// Act
		const response = await app.inject({ method: 'POST', url })

		// Assert
		expect(response.statusCode).toBe(201)
		expect(app.jobService.start).toHaveBeenCalledWith('order-1', { ...session, role: 'admin' })
		expect(app.orderService.transition).toHaveBeenCalledWith('order-1', 'building')
	})

	it('Responds 404 for an unknown order', async () => {
		vi.spyOn(app.orderService, 'get').mockRejectedValue(new EntityNotFound('order', 'order-1'))
		expect((await app.inject({ method: 'POST', url })).statusCode).toBe(404)
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

import { EntityNotFound } from '#/lib/entityError.ts'
import postApproveBuild from '#/routes/bff/admin/orders/postApproveBuild.ts'
import { DemoNotApprovable, DemoWeeklyCapReached } from '#/services/orderService.ts'

import type { FastifyInstance } from 'fastify'

const session = { userId: 'user-1', role: 'user', orgId: 'org-1' }

describe('POST /bff/admin/orders/:orderId/approve-build route', () => {
	let app: FastifyInstance

	const url = '/bff/admin/orders/order-1/approve-build'

	beforeEach(async () => {
		app = await createTestApp()
		app.register(postApproveBuild)
	})

	it('Approves the demo build and returns the building order', async () => {
		// Act
		const response = await app.inject({ method: 'POST', url, payload: {} })

		// Assert
		expect(app.orderService.approveDemoBuild).toHaveBeenCalledWith('order-1', session, {
			force: undefined,
		})
		expect(response.statusCode).toBe(200)
		expect(response.json()).toMatchObject({
			id: 'order-1',
			kind: 'demo',
			status: 'building',
			buildApprovedAt: expect.any(String),
		})
	})

	it('Passes `force` through to bypass the weekly cap', async () => {
		const response = await app.inject({ method: 'POST', url, payload: { force: true } })

		expect(response.statusCode).toBe(200)
		expect(app.orderService.approveDemoBuild).toHaveBeenCalledWith('order-1', session, {
			force: true,
		})
	})

	it('Rejects a body with unknown or mistyped fields', async () => {
		expect((await app.inject({ method: 'POST', url, payload: { force: 'yes' } })).statusCode).toBe(
			400
		)
		expect((await app.inject({ method: 'POST', url, payload: { confirm: true } })).statusCode).toBe(
			400
		)
		expect(app.orderService.approveDemoBuild).not.toHaveBeenCalled()
	})

	it('Responds 409 demoWeeklyCapReached with the count when the week is full', async () => {
		vi.spyOn(app.orderService, 'approveDemoBuild').mockRejectedValueOnce(
			new DemoWeeklyCapReached('order-1', 5, 5)
		)

		const response = await app.inject({ method: 'POST', url, payload: {} })

		expect(response.statusCode).toBe(409)
		expect(response.json().error).toMatchObject({
			code: 'demoWeeklyCapReached',
			variables: { approved: 5, cap: 5 },
		})
	})

	it('Responds 409 demoNotApprovable for a real build or a demo not in deposit_paid', async () => {
		vi.spyOn(app.orderService, 'approveDemoBuild').mockRejectedValueOnce(
			new DemoNotApprovable('order-1')
		)

		const response = await app.inject({ method: 'POST', url, payload: {} })

		expect(response.statusCode).toBe(409)
		expect(response.json().error.code).toBe('demoNotApprovable')
	})

	it('Handles an unknown order with 404 and other failures with 500', async () => {
		vi.spyOn(app.orderService, 'approveDemoBuild').mockRejectedValueOnce(
			new EntityNotFound('order', 'order-1')
		)
		expect((await app.inject({ method: 'POST', url, payload: {} })).statusCode).toBe(404)

		vi.spyOn(app.orderService, 'approveDemoBuild').mockRejectedValueOnce(new Error('Fail'))
		expect((await app.inject({ method: 'POST', url, payload: {} })).statusCode).toBe(500)
	})
})

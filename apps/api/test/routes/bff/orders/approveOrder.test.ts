import { EntityNotFound } from '#/lib/entityError.ts'
import approveOrder from '#/routes/bff/orders/approveOrder.ts'
import { InvalidOrderTransition } from '#/services/orderService.ts'

import type { FastifyInstance } from 'fastify'

const session = { userId: 'user-1', role: 'user', orgId: 'org-1' }

describe('POST /bff/orders/:orderId/approve route', () => {
	let app: FastifyInstance

	const url = '/bff/orders/order-1/approve'

	beforeEach(async () => {
		app = await createTestApp()
		app.register(approveOrder)
	})

	it('Approves the order and delivers it', async () => {
		const response = await app.inject({ method: 'POST', url })

		expect(app.orderService.approve).toHaveBeenCalledWith('order-1', session)
		expect(response.statusCode).toBe(200)
		expect(response.json()).toMatchObject({ id: 'order-1', status: 'delivered' })
	})

	it('Responds 409 orderTransitionInvalid when the order is not awaiting approval', async () => {
		vi.spyOn(app.orderService, 'approve').mockRejectedValue(
			new InvalidOrderTransition('order-1', 'building', 'delivered')
		)

		const response = await app.inject({ method: 'POST', url })

		expect(response.statusCode).toBe(409)
		expect(response.json().error.code).toBe('orderTransitionInvalid')
	})

	it('Handles unknown order with 404 and other failures with 500', async () => {
		vi.spyOn(app.orderService, 'approve').mockRejectedValueOnce(new EntityNotFound('order'))
		expect((await app.inject({ method: 'POST', url })).statusCode).toBe(404)

		vi.spyOn(app.orderService, 'approve').mockRejectedValueOnce(new Error('Fail'))
		expect((await app.inject({ method: 'POST', url })).statusCode).toBe(500)
	})
})

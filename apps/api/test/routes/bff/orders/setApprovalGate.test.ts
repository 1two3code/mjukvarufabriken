import { EntityNotFound } from '#/lib/entityError.ts'
import setApprovalGate from '#/routes/bff/orders/setApprovalGate.ts'

import type { FastifyInstance } from 'fastify'

const session = { userId: 'user-1', role: 'user', orgId: 'org-1' }

describe('PATCH /bff/orders/:orderId/approval-gate route', () => {
	let app: FastifyInstance

	const url = '/bff/orders/order-1/approval-gate'

	beforeEach(async () => {
		app = await createTestApp()
		app.register(setApprovalGate)
	})

	it('Turns the gate on', async () => {
		const response = await app.inject({ method: 'PATCH', url, payload: { enabled: true } })

		expect(app.orderService.setApprovalGate).toHaveBeenCalledWith('order-1', true, session)
		expect(response.statusCode).toBe(200)
		expect(response.json()).toMatchObject({ id: 'order-1', approveBeforeDeliver: true })
	})

	it('Rejects a body that is not { enabled: boolean }', async () => {
		expect(
			(await app.inject({ method: 'PATCH', url, payload: {} })).statusCode
		).toBe(400)
		expect(
			(await app.inject({ method: 'PATCH', url, payload: { enabled: 'yes' } })).statusCode
		).toBe(400)
	})

	it('Handles unknown order with 404 and other failures with 500', async () => {
		vi.spyOn(app.orderService, 'setApprovalGate').mockRejectedValueOnce(new EntityNotFound('order'))
		expect(
			(await app.inject({ method: 'PATCH', url, payload: { enabled: true } })).statusCode
		).toBe(404)

		vi.spyOn(app.orderService, 'setApprovalGate').mockRejectedValueOnce(new Error('Fail'))
		expect(
			(await app.inject({ method: 'PATCH', url, payload: { enabled: true } })).statusCode
		).toBe(500)
	})
})

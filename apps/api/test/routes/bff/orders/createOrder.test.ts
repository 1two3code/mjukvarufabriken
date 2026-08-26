import createOrder from '#/routes/bff/orders/createOrder.ts'
import { createMockOrder } from '#/services/__mocks__/orderService.ts'

import type { FastifyInstance } from 'fastify'

const session = { userId: 'user-1', role: 'user', orgId: 'org-1' }

describe('POST /bff/orders route', () => {
	let app: FastifyInstance

	const url = '/bff/orders'

	beforeEach(async () => {
		app = await createTestApp()
		app.register(createOrder)
	})

	it('Creates an order and returns it with 201', async () => {
		// Arrange
		const order = createMockOrder({ name: 'Gym booking' })
		vi.spyOn(app.orderService, 'create').mockResolvedValue(order)

		// Act
		const response = await app.inject({ method: 'POST', url, payload: { name: 'Gym booking' } })

		// Assert
		expect(app.orderService.create).toHaveBeenCalledWith('Gym booking', session)
		expect(response.statusCode).toBe(201)
		expect(response.json()).toEqual(order)
	})

	it('Rejects an empty or too long name with 400', async () => {
		expect((await app.inject({ method: 'POST', url, payload: { name: '   ' } })).statusCode).toBe(
			400
		)
		expect(
			(await app.inject({ method: 'POST', url, payload: { name: 'x'.repeat(121) } })).statusCode
		).toBe(400)
		expect(app.orderService.create).not.toHaveBeenCalled()
	})

	it('Handles server error with 500 response', async () => {
		// Arrange
		vi.spyOn(app.orderService, 'create').mockRejectedValue(new Error('Fail'))

		// Act
		const response = await app.inject({ method: 'POST', url, payload: { name: 'x' } })

		// Assert
		expect(response.statusCode).toBe(500)
	})
})

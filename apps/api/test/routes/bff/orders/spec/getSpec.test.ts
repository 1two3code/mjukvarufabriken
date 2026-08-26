import getSpec from '#/routes/bff/orders/spec/getSpec.ts'
import { createMockSpecDraft } from '#/services/__mocks__/specService.ts'

import type { FastifyInstance } from 'fastify'

describe('GET /bff/orders/:orderId/spec route', () => {
	let app: FastifyInstance

	const url = '/bff/orders/order-1/spec'

	beforeEach(async () => {
		app = await createTestApp()
		app.register(getSpec)
	})

	it('Returns the spec draft for the order', async () => {
		// Arrange
		// Act
		const response = await app.inject({ url })

		// Assert
		expect(app.specService.get).toHaveBeenCalledWith('order-1')
		expect(response.statusCode).toBe(200)
		expect(response.json()).toEqual(createMockSpecDraft({ orderId: 'order-1' }))
	})

	it('Handles server error with 500 response', async () => {
		// Arrange
		vi.spyOn(app.specService, 'get').mockRejectedValue(new Error('Fail'))

		// Act
		const response = await app.inject({ url })

		// Assert
		expect(response.statusCode).toBe(500)
	})
})

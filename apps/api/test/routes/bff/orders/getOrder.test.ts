import { EntityNotFound } from '#/lib/entityError.ts'
import getOrder from '#/routes/bff/orders/getOrder.ts'
import { createMockOrderDetail } from '#/services/__mocks__/orderService.ts'

import type { FastifyInstance } from 'fastify'

const session = { userId: 'user-1', role: 'user', orgId: 'org-1' }

describe('GET /bff/orders/:orderId route', () => {
	let app: FastifyInstance

	const url = '/bff/orders/order-1'

	beforeEach(async () => {
		app = await createTestApp()
		app.register(getOrder)
	})

	it('Returns the order detail', async () => {
		// Arrange
		// Act
		const response = await app.inject({ url })

		// Assert
		expect(app.orderService.getDetail).toHaveBeenCalledWith('order-1', session)
		expect(response.statusCode).toBe(200)
		expect(response.json()).toEqual(createMockOrderDetail({ order: { id: 'order-1' } }))
	})

	it('Serialises the hosting outcome and the job list (wave 14, F7)', async () => {
		// Arrange
		const detail = createMockOrderDetail({
			order: { id: 'order-1', status: 'delivered' },
			hosting: { status: 'unhosted', deployUrl: null, reason: 'acceptance: blank page' },
			jobs: [
				{
					id: 'job-2',
					status: 'delivered',
					mode: 'redeliver',
					sourceJobId: 'job-1',
					reason: 'acceptance: blank page',
					tokensUsed: 10,
					budget: { maxTokens: 100, maxWorkers: 1, maxDurationMinutes: 10 },
					createdAt: '2026-09-02T10:00:00.000Z',
				},
			],
		})
		vi.spyOn(app.orderService, 'getDetail').mockResolvedValue(detail)

		// Act
		const response = await app.inject({ url })

		// Assert
		expect(response.statusCode).toBe(200)
		expect(response.json()).toMatchObject({
			hosting: { status: 'unhosted', deployUrl: null, reason: 'acceptance: blank page' },
			jobs: [{ id: 'job-2', mode: 'redeliver', sourceJobId: 'job-1' }],
		})
	})

	it('Handles unknown order with 404 response', async () => {
		// Arrange
		vi.spyOn(app.orderService, 'getDetail').mockRejectedValue(new EntityNotFound('order'))

		// Act
		const response = await app.inject({ url })

		// Assert
		expect(response.statusCode).toBe(404)
	})

	it('Handles server error with 500 response', async () => {
		// Arrange
		vi.spyOn(app.orderService, 'getDetail').mockRejectedValue(new Error('Fail'))

		// Act
		const response = await app.inject({ url })

		// Assert
		expect(response.statusCode).toBe(500)
	})
})

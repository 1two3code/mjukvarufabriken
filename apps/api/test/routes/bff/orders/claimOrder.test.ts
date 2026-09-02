import { EntityNotFound } from '#/lib/entityError.ts'
import claimOrder from '#/routes/bff/orders/claimOrder.ts'
import { mockQuoteToken } from '#/services/__mocks__/quoteService.ts'
import { ClaimRateLimited } from '#/services/orderService.ts'

import type { FastifyInstance } from 'fastify'

const url = '/bff/orders/claim'
const payload = { orderId: 'order-1', token: mockQuoteToken }

describe('POST /bff/orders/claim route', () => {
	let app: FastifyInstance

	beforeEach(async () => {
		app = await createTestApp()
		app.register(claimOrder)
	})

	it('Claims the quote for the session and returns the order', async () => {
		// Act
		const response = await app.inject({ method: 'POST', url, payload })

		// Assert
		expect(response.statusCode).toBe(200)
		expect(response.json()).toMatchObject({ id: 'order-1', orgId: 'org-1', createdBy: 'user-1' })
		expect(app.orderService.claim).toHaveBeenCalledWith('order-1', mockQuoteToken, {
			userId: 'user-1',
			role: 'user',
			orgId: 'org-1',
		})
	})

	it.each([
		['a malformed token', { orderId: 'order-1', token: 'nope' }],
		['a missing order id', { token: mockQuoteToken }],
		['an unknown field', { ...payload, orgId: 'org-2' }],
	])('Rejects %s with 400', async (_label, body) => {
		// Act
		const response = await app.inject({ method: 'POST', url, payload: body })

		// Assert
		expect(response.statusCode).toBe(400)
		expect(app.orderService.claim).not.toHaveBeenCalled()
	})

	it('Answers 404 for a wrong token, a second claim or an unknown order', async () => {
		// Arrange
		vi.spyOn(app.orderService, 'claim').mockRejectedValueOnce(
			new EntityNotFound('order', 'order-1')
		)

		// Act
		const response = await app.inject({ method: 'POST', url, payload })

		// Assert
		expect(response.statusCode).toBe(404)
	})

	it('Answers 429 claimRateLimited when the session claims too often', async () => {
		// Arrange
		vi.spyOn(app.orderService, 'claim').mockRejectedValueOnce(new ClaimRateLimited('user-1'))

		// Act
		const response = await app.inject({ method: 'POST', url, payload })

		// Assert
		expect(response.statusCode).toBe(429)
		expect(response.json().error.code).toBe('claimRateLimited')
	})
})

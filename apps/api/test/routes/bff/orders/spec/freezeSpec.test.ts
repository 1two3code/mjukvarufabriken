import { EntityInvalid } from '#/lib/entityError.ts'
import freezeSpec from '#/routes/bff/orders/spec/freezeSpec.ts'
import { createMockSpec, createMockSpecDraft } from '#/services/__mocks__/specService.ts'

import type { FastifyInstance } from 'fastify'

describe('POST /bff/orders/:orderId/spec/freeze route', () => {
	let app: FastifyInstance

	const url = '/bff/orders/order-1/spec/freeze'

	beforeEach(async () => {
		app = await createTestApp()
		app.register(freezeSpec)
	})

	it('Freezes the draft and returns it', async () => {
		// Arrange
		const frozen = createMockSpecDraft({
			orderId: 'order-1',
			status: 'frozen',
			spec: { ...createMockSpec(), sizeClass: 'S' },
			priceSek: 15_000,
			frozenAt: '2026-08-26T12:00:00.000Z',
		})
		vi.spyOn(app.specService, 'freeze').mockResolvedValue(frozen)

		// Act
		const response = await app.inject({ method: 'POST', url })

		// Assert
		expect(app.specService.freeze).toHaveBeenCalledWith('order-1', {
			userId: 'user-1',
			role: 'user',
			orgId: 'org-1',
		})
		expect(response.statusCode).toBe(200)
		expect(response.json()).toEqual(frozen)
	})

	it('Responds 409 specIncomplete when the spec is incomplete', async () => {
		// Arrange
		vi.spyOn(app.specService, 'freeze').mockRejectedValue(new EntityInvalid('spec', 'order-1'))

		// Act
		const response = await app.inject({ method: 'POST', url })

		// Assert
		expect(response.statusCode).toBe(409)
		expect(response.json().error.code).toBe('specIncomplete')
	})

	it('Handles server error with 500 response', async () => {
		// Arrange
		vi.spyOn(app.specService, 'freeze').mockRejectedValue(new Error('Fail'))

		// Act
		const response = await app.inject({ method: 'POST', url })

		// Assert
		expect(response.statusCode).toBe(500)
	})
})

import { EntityNotFound } from '#/lib/entityError.ts'
import postExport from '#/routes/bff/admin/orders/postExport.ts'
import { createMockOrderExport } from '#/services/__mocks__/exportService.ts'

import type { FastifyInstance } from 'fastify'

describe('POST /bff/admin/orders/:orderId/export route', () => {
	let app: FastifyInstance

	const url = '/bff/admin/orders/order-1/export'

	beforeEach(async () => {
		app = await createTestApp()
		app.register(postExport)
	})

	it('Takes the final export and returns the row', async () => {
		// Act
		const response = await app.inject({ method: 'POST', url })

		// Assert
		expect(app.exportService.finalExport).toHaveBeenCalledWith('order-1')
		expect(response.statusCode).toBe(200)
		expect(response.json()).toEqual(createMockOrderExport({ orderId: 'order-1' }))
	})

	it('Returns a failed export as 200 with its reason (the row is the report)', async () => {
		// Arrange
		vi.spyOn(app.exportService, 'finalExport').mockResolvedValue(
			createMockOrderExport({ status: 'failed', error: 'S3 down', files: [] })
		)

		// Act
		const response = await app.inject({ method: 'POST', url })

		// Assert
		expect(response.statusCode).toBe(200)
		expect(response.json()).toMatchObject({ status: 'failed', error: 'S3 down' })
	})

	it('Maps an unknown order to 404', async () => {
		// Arrange
		vi.spyOn(app.exportService, 'finalExport').mockRejectedValue(
			new EntityNotFound('order', 'order-1')
		)

		// Act
		const response = await app.inject({ method: 'POST', url })

		// Assert
		expect(response.statusCode).toBe(404)
	})
})

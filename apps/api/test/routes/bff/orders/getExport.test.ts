import { EntityNotFound } from '#/lib/entityError.ts'
import getExport from '#/routes/bff/orders/getExport.ts'
import { createMockOrderExportResponse } from '#/services/__mocks__/exportService.ts'

import type { FastifyInstance } from 'fastify'

const session = { userId: 'user-1', role: 'user', orgId: 'org-1' }

describe('GET /bff/orders/:orderId/export route', () => {
	let app: FastifyInstance

	const url = '/bff/orders/order-1/export'

	beforeEach(async () => {
		app = await createTestApp()
		app.register(getExport)
	})

	it('Returns the export with presigned download links', async () => {
		// Act
		const response = await app.inject({ url })

		// Assert
		expect(app.exportService.getForOrder).toHaveBeenCalledWith('order-1', session)
		expect(response.statusCode).toBe(200)
		expect(response.json()).toEqual(createMockOrderExportResponse({ orderId: 'order-1' }))
		expect(response.json().files[0].url).toMatch(/X-Amz-Signature/)
	})

	it('Handles an order without an export (or unknown / other org) with 404', async () => {
		// Arrange
		vi.spyOn(app.exportService, 'getForOrder').mockRejectedValue(
			new EntityNotFound('export', 'order-1')
		)

		// Act
		const response = await app.inject({ url })

		// Assert
		expect(response.statusCode).toBe(404)
	})

	it('Answers 503 when the api has no artifacts bucket', async () => {
		// Arrange
		app.s3.configured = false

		// Act
		const response = await app.inject({ url })

		// Assert
		expect(response.statusCode).toBe(503)
		expect(app.exportService.getForOrder).not.toHaveBeenCalled()
	})
})

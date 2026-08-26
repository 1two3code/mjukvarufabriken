import postResidentBilling from '#/routes/bff/admin/resident/postResidentBilling.ts'

import type { FastifyInstance } from 'fastify'

describe('POST /bff/admin/resident/usage/:month/bill route', () => {
	let app: FastifyInstance

	const url = '/bff/admin/resident/usage/2026-09/bill'

	beforeEach(async () => {
		app = await createTestApp()
		app.register(postResidentBilling)
	})

	it('Runs the billing for the month and returns the outcome per installation', async () => {
		// Arrange
		// Act
		const response = await app.inject({ method: 'POST', url })

		// Assert
		expect(response.statusCode).toBe(200)
		expect(app.paymentService.billResidentUsage).toHaveBeenCalledWith('2026-09')
		expect(response.json()).toMatchObject({
			month: '2026-09',
			results: [{ installationId: 'acme-shop', outcome: 'reported', usdCents: 2_025 }],
		})
	})

	it('Rejects a malformed month with 400', async () => {
		const response = await app.inject({ method: 'POST', url: '/bff/admin/resident/usage/sep/bill' })

		expect(response.statusCode).toBe(400)
		expect(app.paymentService.billResidentUsage).not.toHaveBeenCalled()
	})

	it('Handles server error with 500 response', async () => {
		// Arrange
		vi.spyOn(app.paymentService, 'billResidentUsage').mockRejectedValue(new Error('Fail'))

		// Act
		const response = await app.inject({ method: 'POST', url })

		// Assert
		expect(response.statusCode).toBe(500)
	})
})

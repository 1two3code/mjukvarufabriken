import getResidentUsage from '#/routes/bff/admin/resident/getResidentUsage.ts'
import { createMockResidentUsageSummary } from '#/services/__mocks__/residentService.ts'

import type { FastifyInstance } from 'fastify'

describe('GET /bff/admin/resident/usage route', () => {
	let app: FastifyInstance

	const url = '/bff/admin/resident/usage'

	beforeEach(async () => {
		app = await createTestApp()
		app.register(getResidentUsage)
	})

	it('Returns the monthly summaries, narrowed by the query', async () => {
		// Arrange
		const summary = createMockResidentUsageSummary({ month: '2026-09' })
		vi.spyOn(app.residentService, 'summarizeUsage').mockResolvedValue([summary])

		// Act
		const response = await app.inject({ url: `${url}?month=2026-09&installationId=acme-shop` })

		// Assert
		expect(response.statusCode).toBe(200)
		expect(response.json()).toEqual([summary])
		expect(app.residentService.summarizeUsage).toHaveBeenCalledWith({
			month: '2026-09',
			installationId: 'acme-shop',
		})
	})

	it('Rejects a malformed month with 400', async () => {
		const response = await app.inject({ url: `${url}?month=september` })

		expect(response.statusCode).toBe(400)
	})

	it('Handles server error with 500 response', async () => {
		// Arrange
		vi.spyOn(app.residentService, 'summarizeUsage').mockRejectedValue(new Error('Fail'))

		// Act
		const response = await app.inject({ url })

		// Assert
		expect(response.statusCode).toBe(500)
	})
})

import getResidentInstallations from '#/routes/bff/admin/resident/getResidentInstallations.ts'
import { createMockResidentInstallation } from '#/services/__mocks__/residentService.ts'

import type { FastifyInstance } from 'fastify'

describe('GET /bff/admin/resident/installations route', () => {
	let app: FastifyInstance

	const url = '/bff/admin/resident/installations'

	beforeEach(async () => {
		app = await createTestApp()
		app.register(getResidentInstallations)
	})

	it('Returns every installation', async () => {
		// Arrange
		// Act
		const response = await app.inject({ url })

		// Assert
		expect(response.statusCode).toBe(200)
		expect(response.json()).toEqual([createMockResidentInstallation()])
	})

	it('Handles server error with 500 response', async () => {
		// Arrange
		vi.spyOn(app.residentService, 'listInstallations').mockRejectedValue(new Error('Fail'))

		// Act
		const response = await app.inject({ url })

		// Assert
		expect(response.statusCode).toBe(500)
	})
})

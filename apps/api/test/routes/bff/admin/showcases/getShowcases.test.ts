import getShowcases from '#/routes/bff/admin/showcases/getShowcases.ts'
import { createMockShowcaseAdminRow } from '#/services/__mocks__/showcaseService.ts'

import type { FastifyInstance } from 'fastify'

describe('GET /bff/admin/showcases route', () => {
	let app: FastifyInstance

	const url = '/bff/admin/showcases'

	beforeEach(async () => {
		app = await createTestApp()
		app.register(getShowcases)
	})

	it('Returns every showcase row with its order details', async () => {
		// Arrange
		const row = createMockShowcaseAdminRow({ published: false })
		vi.spyOn(app.showcaseService, 'listAdmin').mockResolvedValue([row])

		// Act
		const response = await app.inject({ url })

		// Assert
		expect(response.statusCode).toBe(200)
		expect(response.json()).toEqual([row])
	})

	it('Handles server error with 500 response', async () => {
		// Arrange
		vi.spyOn(app.showcaseService, 'listAdmin').mockRejectedValue(new Error('Fail'))

		// Act
		const response = await app.inject({ url })

		// Assert
		expect(response.statusCode).toBe(500)
	})
})

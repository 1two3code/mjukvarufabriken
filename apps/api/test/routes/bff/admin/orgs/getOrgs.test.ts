import getOrgs from '#/routes/bff/admin/orgs/getOrgs.ts'

import type { FastifyInstance } from 'fastify'

describe('GET /bff/admin/orgs route', () => {
	let app: FastifyInstance

	const url = '/bff/admin/orgs'

	beforeEach(async () => {
		app = await createTestApp()
		app.register(getOrgs)
	})

	it('Returns every org', async () => {
		// Arrange
		const org = await app.db.users.insertOrg({ name: 'acme.se' })

		// Act
		const response = await app.inject({ url })

		// Assert
		expect(response.statusCode).toBe(200)
		expect(response.json()).toEqual([org])
	})

	it('Handles server error with 500 response', async () => {
		// Arrange
		vi.spyOn(app.db.users, 'listOrgs').mockRejectedValue(new Error('Fail'))

		// Act
		const response = await app.inject({ url })

		// Assert
		expect(response.statusCode).toBe(500)
	})
})

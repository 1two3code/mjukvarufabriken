import putResidentInstallation from '#/routes/bff/admin/resident/putResidentInstallation.ts'

import type { FastifyInstance } from 'fastify'

describe('PUT /bff/admin/resident/installations/:id route', () => {
	let app: FastifyInstance

	const url = '/bff/admin/resident/installations/acme-shop'

	beforeEach(async () => {
		app = await createTestApp()
		app.register(putResidentInstallation)
	})

	it('Links the installation to an org and a billing customer', async () => {
		// Arrange
		const payload = { orgId: 'org-9', billingCustomerId: 'cus_9' }

		// Act
		const response = await app.inject({ method: 'PUT', url, payload })

		// Assert
		expect(response.statusCode).toBe(200)
		expect(app.residentService.upsertInstallation).toHaveBeenCalledWith('acme-shop', payload)
		expect(response.json()).toMatchObject({
			id: 'acme-shop',
			orgId: 'org-9',
			billingCustomerId: 'cus_9',
		})
	})

	it('Accepts null to clear a field and rejects unknown fields', async () => {
		const cleared = await app.inject({ method: 'PUT', url, payload: { billingCustomerId: null } })
		const unknown = await app.inject({ method: 'PUT', url, payload: { token: 'x' } })

		expect(cleared.statusCode).toBe(200)
		expect(cleared.json()).not.toHaveProperty('billingCustomerId')
		expect(unknown.statusCode).toBe(400)
	})

	it('Handles server error with 500 response', async () => {
		// Arrange
		vi.spyOn(app.residentService, 'upsertInstallation').mockRejectedValue(new Error('Fail'))

		// Act
		const response = await app.inject({ method: 'PUT', url, payload: {} })

		// Assert
		expect(response.statusCode).toBe(500)
	})
})

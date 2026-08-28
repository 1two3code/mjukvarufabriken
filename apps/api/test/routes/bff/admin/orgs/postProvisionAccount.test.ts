import postProvisionAccount from '#/routes/bff/admin/orgs/postProvisionAccount.ts'
import { EntityNotFound } from '#/lib/entityError.ts'
import { OrgNotConfigured } from '#/plugins/org.ts'

import type { FastifyInstance } from 'fastify'

describe('POST /bff/admin/orgs/:orgId/provision-account route', () => {
	let app: FastifyInstance

	const url = '/bff/admin/orgs/org-1/provision-account'

	beforeEach(async () => {
		app = await createTestApp()
		app.register(postProvisionAccount)
	})

	it('Provisions the org account and returns the recorded org', async () => {
		const response = await app.inject({ method: 'POST', url })

		expect(response.statusCode).toBe(200)
		expect(app.accountService.provisionCustomerAccount).toHaveBeenCalledWith('org-1')
		expect(response.json()).toMatchObject({
			skipped: false,
			accountId: '123456789012',
			org: { id: 'org-1', awsAccountId: '123456789012' },
		})
	})

	it('Maps EntityNotFound to 404', async () => {
		vi.spyOn(app.accountService, 'provisionCustomerAccount').mockRejectedValue(
			new EntityNotFound('org', 'org-1')
		)

		const response = await app.inject({ method: 'POST', url })

		expect(response.statusCode).toBe(404)
	})

	it('Maps OrgNotConfigured to 409 (flag on but clients not wired)', async () => {
		vi.spyOn(app.accountService, 'provisionCustomerAccount').mockRejectedValue(new OrgNotConfigured())

		const response = await app.inject({ method: 'POST', url })

		expect(response.statusCode).toBe(409)
	})
})

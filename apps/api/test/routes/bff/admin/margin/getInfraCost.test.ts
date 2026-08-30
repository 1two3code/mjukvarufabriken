import { allocateInfraCost } from '@mf/models'

import getInfraCost from '#/routes/bff/admin/margin/getInfraCost.ts'

import type { FastifyInstance } from 'fastify'

describe('GET /bff/admin/margin/infra-cost route', () => {
	let app: FastifyInstance

	const url = '/bff/admin/margin/infra-cost'

	beforeEach(async () => {
		app = await createTestApp()
		app.register(getInfraCost)
	})

	it('Returns the infra cost allocation', async () => {
		// Arrange
		const allocation = allocateInfraCost(['org-1', 'org-2'])
		vi.spyOn(app.marginService, 'infraCostAllocation').mockResolvedValue(allocation)

		// Act
		const response = await app.inject({ url })

		// Assert
		expect(response.statusCode).toBe(200)
		expect(response.json()).toEqual(allocation)
	})

	it('Handles server error with 500 response', async () => {
		// Arrange
		vi.spyOn(app.marginService, 'infraCostAllocation').mockRejectedValue(new Error('Fail'))

		// Act
		const response = await app.inject({ url })

		// Assert
		expect(response.statusCode).toBe(500)
	})
})

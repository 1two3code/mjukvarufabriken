import getModelPrices from '#/routes/bff/admin/modelPrices/getModelPrices.ts'
import postModelPrice from '#/routes/bff/admin/modelPrices/postModelPrice.ts'

import type { FastifyInstance } from 'fastify'

describe('/bff/admin/model-prices routes', () => {
	let app: FastifyInstance

	const url = '/bff/admin/model-prices'
	const price = {
		modelPrefix: 'claude-sonnet',
		input: 2,
		output: 10,
		cacheRead: 0.2,
		cacheWrite: 2.5,
		effectiveFrom: '2026-09-01T00:00:00.000Z',
	}

	beforeEach(async () => {
		app = await createTestApp()
		app.register(getModelPrices)
		app.register(postModelPrice)
	})

	it('Lists the seeded prices for admins', async () => {
		const response = await app.inject({ url })

		expect(response.statusCode).toBe(200)
		expect(response.json()).toEqual(
			expect.arrayContaining([expect.objectContaining({ modelPrefix: 'claude-sonnet', input: 3 })])
		)
	})

	it('Adds a price row and lists it first (newest effectiveFrom)', async () => {
		const created = await app.inject({ url, method: 'POST', payload: price })

		expect(created.statusCode).toBe(201)
		expect(created.json()).toMatchObject(price)
		const listed = await app.inject({ url })
		expect(listed.json()[0]).toMatchObject(price)
	})

	it('Rejects an exact duplicate with 409 and a malformed body with 400', async () => {
		await app.inject({ url, method: 'POST', payload: price })

		expect((await app.inject({ url, method: 'POST', payload: price })).statusCode).toBe(409)
		expect(
			(await app.inject({ url, method: 'POST', payload: { ...price, input: -1 } })).statusCode
		).toBe(400)
		expect(
			(await app.inject({ url, method: 'POST', payload: { ...price, extra: 1 } })).statusCode
		).toBe(400)
	})

	it('Handles server error with 500 response', async () => {
		vi.spyOn(app.db.modelPrices, 'list').mockRejectedValue(new Error('Fail'))

		expect((await app.inject({ url })).statusCode).toBe(500)
	})
})

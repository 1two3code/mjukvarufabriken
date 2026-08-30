import getPricingTiers from '#/routes/bff/admin/pricingTiers/getPricingTiers.ts'
import postPricingTier from '#/routes/bff/admin/pricingTiers/postPricingTier.ts'

import type { FastifyInstance } from 'fastify'

describe('/bff/admin/pricing-tiers routes', () => {
	let app: FastifyInstance

	const url = '/bff/admin/pricing-tiers'
	const tier = {
		tierKey: 'starter',
		name: 'Starter',
		price: 299,
		currency: 'SEK',
		description: 'A small demo build',
		effectiveFrom: '2026-09-01T00:00:00.000Z',
	}

	beforeEach(async () => {
		app = await createTestApp()
		app.register(getPricingTiers)
		app.register(postPricingTier)
	})

	it('Lists an empty table — no built-in seed', async () => {
		const response = await app.inject({ url })

		expect(response.statusCode).toBe(200)
		expect(response.json()).toEqual([])
	})

	it('Adds a tier row and lists it', async () => {
		const created = await app.inject({ url, method: 'POST', payload: tier })

		expect(created.statusCode).toBe(201)
		expect(created.json()).toMatchObject(tier)
		const listed = await app.inject({ url })
		expect(listed.json()[0]).toMatchObject(tier)
	})

	it('Rejects an exact duplicate with 409 and a malformed body with 400', async () => {
		await app.inject({ url, method: 'POST', payload: tier })

		expect((await app.inject({ url, method: 'POST', payload: tier })).statusCode).toBe(409)
		expect(
			(await app.inject({ url, method: 'POST', payload: { ...tier, price: -1 } })).statusCode
		).toBe(400)
		expect(
			(await app.inject({ url, method: 'POST', payload: { ...tier, extra: 1 } })).statusCode
		).toBe(400)
	})

	it('Handles server error with 500 response', async () => {
		vi.spyOn(app.db.pricingTiers, 'list').mockRejectedValue(new Error('Fail'))

		expect((await app.inject({ url })).statusCode).toBe(500)
	})
})

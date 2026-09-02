import { EntityNotFound } from '#/lib/entityError.ts'
import putShowcase from '#/routes/bff/admin/orders/putShowcase.ts'
import { ShowcaseNoLiveUrl } from '#/services/showcaseService.ts'

import type { FastifyInstance } from 'fastify'

describe('PUT /bff/admin/orders/:orderId/showcase route', () => {
	let app: FastifyInstance

	const url = '/bff/admin/orders/order-1/showcase'
	const body = {
		published: true,
		title: 'Gym booking',
		blurbSv: 'Boka pass',
		blurbEn: 'Book classes',
		url: 'https://gym.example',
		sort: 2,
	}

	beforeEach(async () => {
		app = await createTestApp()
		app.register(putShowcase)
	})

	it('Writes the row and returns it', async () => {
		// Act
		const response = await app.inject({ method: 'PUT', url, payload: body })

		// Assert
		expect(response.statusCode).toBe(200)
		expect(response.json()).toMatchObject({ orderId: 'order-1', ...body })
		expect(app.showcaseService.upsert).toHaveBeenCalledWith('order-1', body)
	})

	it('Defaults the blurbs and sort, and passes no url when left out', async () => {
		// Act
		const response = await app.inject({
			method: 'PUT',
			url,
			payload: { published: false, title: 'Gym booking' },
		})

		// Assert
		expect(response.statusCode).toBe(200)
		expect(app.showcaseService.upsert).toHaveBeenCalledWith('order-1', {
			published: false,
			title: 'Gym booking',
			blurbSv: '',
			blurbEn: '',
			sort: 0,
		})
	})

	it('Handles unknown order with 404 response', async () => {
		// Arrange
		vi.spyOn(app.showcaseService, 'upsert').mockRejectedValueOnce(
			new EntityNotFound('order', 'order-1')
		)

		// Act
		const response = await app.inject({ method: 'PUT', url, payload: body })

		// Assert
		expect(response.statusCode).toBe(404)
	})

	it('Answers 409 with a coded error when publishing without any live url', async () => {
		// Arrange
		vi.spyOn(app.showcaseService, 'upsert').mockRejectedValueOnce(new ShowcaseNoLiveUrl('order-1'))

		// Act
		const response = await app.inject({ method: 'PUT', url, payload: body })

		// Assert
		expect(response.statusCode).toBe(409)
		expect(response.json().error.code).toBe('showcaseNoLiveUrl')
	})

	it.each([
		['an empty title', { title: ' ' }],
		['a non-http url', { url: 'ftp://gym.example' }],
		['a malformed url', { url: 'gym' }],
		['an unknown field', { extra: 1 }],
		['a fractional sort', { sort: 1.5 }],
	])('Rejects a body with %s with 400', async (_label, overrides) => {
		// Act
		const response = await app.inject({ method: 'PUT', url, payload: { ...body, ...overrides } })

		// Assert
		expect(response.statusCode).toBe(400)
		expect(app.showcaseService.upsert).not.toHaveBeenCalled()
	})

	it('Handles server error with 500 response', async () => {
		// Arrange
		vi.spyOn(app.showcaseService, 'upsert').mockRejectedValueOnce(new Error('Fail'))

		// Act
		const response = await app.inject({ method: 'PUT', url, payload: body })

		// Assert
		expect(response.statusCode).toBe(500)
	})
})

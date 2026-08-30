import { z } from 'zod'

import type { FastifyInstance } from 'fastify'

describe('Error handling plugin', () => {
	let app: FastifyInstance

	beforeEach(async () => {
		app = await createTestApp({ skipMock: '#/plugins/errorHandling.ts' })
	})

	it('Decorates the reply with an error function', async () => {
		// Arrange
		// Act
		// Assert
		expect(app.hasReplyDecorator('error')).toBe(true)
	})

	it('Catches uncaught route errors and returns a 500 response without details', async () => {
		// Arrange
		const expectedOutput = {
			status: 500,
			message: 'Details could contain sensitive data and is therefore logged server-side: req-1',
			requestId: 'req-1',
			timestamp: expect.any(String),
			path: '/endpoint',
		}
		const routeError = new Error('Random error')
		app.get('/endpoint', () => {
			throw routeError
		})
		vi.spyOn(app.log, 'error')

		// Act
		const response = await app.inject({ url: '/endpoint' })

		// Assert
		expect(response.statusCode).toBe(500)
		expect(response.json()).toEqual({ error: expectedOutput })
		expect(app.log.error).toHaveBeenCalledWith(
			expect.objectContaining({
				...expectedOutput,
				details: expect.objectContaining({ message: 'Random error' }),
				context: { userId: 'user-1' },
			})
		)
		expect(app.sentry.captureException).toHaveBeenCalledWith(routeError)
	})

	it.each([403, 404])('Does not report %i responses to Sentry', async status => {
		// Arrange
		app.get('/endpoint', (_request, reply) => reply.error(status, 'Custom message'))

		// Act
		await app.inject({ url: '/endpoint' })

		// Assert
		expect(app.sentry.captureException).not.toHaveBeenCalled()
	})

	it('Maps schema validation errors to a 400 response', async () => {
		// Arrange
		app.post('/endpoint', { schema: { body: z.object({ name: z.string() }) } }, () => 'ok')

		// Act
		const response = await app.inject({ method: 'POST', url: '/endpoint', payload: { name: 1 } })

		// Assert
		expect(response.statusCode).toBe(400)
		expect(response.json().error.status).toBe(400)
	})

	it('Passes string messages, codes and variables through to the response', async () => {
		// Arrange
		app.get('/endpoint', (_request, reply) =>
			reply.error(409, 'Custom message', 'itemConflict', { name: 'x' })
		)

		// Act
		const response = await app.inject({ url: '/endpoint' })

		// Assert
		expect(response.statusCode).toBe(409)
		expect(response.json().error).toEqual(
			expect.objectContaining({
				status: 409,
				message: 'Custom message',
				code: 'itemConflict',
				variables: { name: 'x' },
			})
		)
	})

	it.each([403, 404])('Logs %i responses as info', async status => {
		// Arrange
		app.get('/endpoint', (_request, reply) => reply.error(status, 'Custom message'))
		vi.spyOn(app.log, 'info')
		vi.spyOn(app.log, 'error')

		// Act
		const response = await app.inject({ url: '/endpoint' })

		// Assert
		expect(response.statusCode).toBe(status)
		expect(app.log.info).toHaveBeenCalledWith(expect.objectContaining({ status }))
		expect(app.log.error).not.toHaveBeenCalled()
	})
})

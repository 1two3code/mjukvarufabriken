import { EntityInvalid } from '#/lib/entityError.ts'
import { AnthropicNotConfigured } from '#/plugins/anthropic.ts'
import postSpecMessage from '#/routes/bff/orders/spec/postSpecMessage.ts'
import { createMockSpecDraft } from '#/services/__mocks__/specService.ts'

import type { FastifyInstance } from 'fastify'

describe('POST /bff/orders/:orderId/spec route', () => {
	let app: FastifyInstance

	const url = '/bff/orders/order-1/spec'
	const payload = { content: 'I want a booking app' }

	beforeEach(async () => {
		app = await createTestApp()
		app.register(postSpecMessage)
	})

	it('Rejects an empty message with 400', async () => {
		// Arrange
		// Act
		const response = await app.inject({ method: 'POST', url, payload: { content: '   ' } })

		// Assert
		expect(response.statusCode).toBe(400)
		expect(app.specService.sendMessage).not.toHaveBeenCalled()
	})

	it('Runs a turn and returns the updated draft', async () => {
		// Arrange
		const draft = createMockSpecDraft({ orderId: 'order-1' })
		vi.spyOn(app.specService, 'sendMessage').mockResolvedValue(draft)

		// Act
		const response = await app.inject({ method: 'POST', url, payload })

		// Assert
		expect(app.specService.sendMessage).toHaveBeenCalledWith('order-1', payload.content)
		expect(response.statusCode).toBe(200)
		expect(response.json()).toEqual(draft)
	})

	it('Responds 409 specFrozen when the draft is frozen', async () => {
		// Arrange
		vi.spyOn(app.specService, 'sendMessage').mockRejectedValue(new EntityInvalid('spec', 'order-1'))

		// Act
		const response = await app.inject({ method: 'POST', url, payload })

		// Assert
		expect(response.statusCode).toBe(409)
		expect(response.json().error.code).toBe('specFrozen')
	})

	it('Responds 503 specEngineUnavailable when no API key is configured', async () => {
		// Arrange
		vi.spyOn(app.specService, 'sendMessage').mockRejectedValue(new AnthropicNotConfigured())

		// Act
		const response = await app.inject({ method: 'POST', url, payload })

		// Assert
		expect(response.statusCode).toBe(503)
		expect(response.json().error.code).toBe('specEngineUnavailable')
	})

	it('Responds 500 specEngineFailed on other errors', async () => {
		// Arrange
		vi.spyOn(app.specService, 'sendMessage').mockRejectedValue(new Error('boom'))

		// Act
		const response = await app.inject({ method: 'POST', url, payload })

		// Assert
		expect(response.statusCode).toBe(500)
		expect(response.json().error.code).toBe('specEngineFailed')
	})
})

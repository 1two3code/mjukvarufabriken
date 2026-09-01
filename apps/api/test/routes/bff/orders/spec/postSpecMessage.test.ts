import { EntityInvalid } from '#/lib/entityError.ts'
import { AnthropicNotConfigured } from '#/plugins/anthropic.ts'
import postSpecMessage from '#/routes/bff/orders/spec/postSpecMessage.ts'
import { createMockSpecDraft } from '#/services/__mocks__/specService.ts'
import { SpecRateLimited, SpecTurnLimitReached } from '#/services/specService.ts'

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
		expect(app.specService.sendMessage).toHaveBeenCalledWith('order-1', payload.content, {
			userId: 'user-1',
			role: 'user',
			orgId: 'org-1',
		})
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

	it('Responds 409 specTurnLimit when the draft has used its turn budget', async () => {
		// Arrange
		vi.spyOn(app.specService, 'sendMessage').mockRejectedValue(
			new SpecTurnLimitReached('order-1')
		)

		// Act
		const response = await app.inject({ method: 'POST', url, payload })

		// Assert — a distinct code from specFrozen: the draft is editable, the conversation is not
		expect(response.statusCode).toBe(409)
		expect(response.json().error.code).toBe('specTurnLimit')
	})

	it('Responds 429 specRateLimited when the order or org window is full', async () => {
		// Arrange
		vi.spyOn(app.specService, 'sendMessage').mockRejectedValue(new SpecRateLimited('order-1'))

		// Act
		const response = await app.inject({ method: 'POST', url, payload })

		// Assert
		expect(response.statusCode).toBe(429)
		expect(response.json().error.code).toBe('specRateLimited')
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

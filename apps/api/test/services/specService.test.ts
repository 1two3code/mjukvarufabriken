import { EntityInvalid, EntityNotFound } from '#/lib/entityError.ts'
import {
	createMockSpecToolOutput,
	createMockToolUseMessage,
} from '#/plugins/__mocks__/anthropic.ts'
import { createMockSpec, createMockSpecDraft } from '#/services/__mocks__/specService.ts'
import { createEmptyDraft } from '#/services/specService.ts'

import type { FastifyInstance } from 'fastify'
import type { BackendSession } from '@mf/models'

const user: BackendSession = { userId: 'user-1', role: 'user', orgId: 'org-1' }
const admin: BackendSession = { userId: 'admin-1', role: 'admin', orgId: 'org-admin' }

describe('Spec Service', () => {
	let app: FastifyInstance

	beforeEach(async () => {
		app = await createTestApp({ skipMock: '#/services/specService.ts' })
	})

	describe('get', () => {
		it('Creates and stores an empty draft on first access', async () => {
			// Arrange
			vi.spyOn(app.store, 'get').mockResolvedValue(undefined)

			// Act
			const draft = await app.specService.get('order-9', user)

			// Assert
			expect(draft).toEqual(createEmptyDraft('order-9', 'org-1'))
			expect(app.store.put).toHaveBeenCalledWith('specs', 'order-9', draft)
		})

		it("Hides another org's draft as not found, but admins see it", async () => {
			// Arrange
			vi.spyOn(app.store, 'get').mockResolvedValue(
				createMockSpecDraft({ orderId: 'order-1', orgId: 'org-2' })
			)

			// Act / Assert
			await expect(app.specService.get('order-1', user)).rejects.toBeInstanceOf(EntityNotFound)
			await expect(app.specService.sendMessage('order-1', 'hi', user)).rejects.toBeInstanceOf(
				EntityNotFound
			)
			await expect(app.specService.freeze('order-1', user)).rejects.toBeInstanceOf(EntityNotFound)
			await expect(app.specService.get('order-1', admin)).resolves.toMatchObject({
				orgId: 'org-2',
			})
			expect(app.store.put).not.toHaveBeenCalled()
		})

		it('Returns the stored draft', async () => {
			// Arrange
			const stored = createMockSpecDraft({ orderId: 'order-1' })
			vi.spyOn(app.store, 'get').mockResolvedValue(stored)

			// Act
			const draft = await app.specService.get('order-1', user)

			// Assert
			expect(app.store.get).toHaveBeenCalledWith('specs', 'order-1')
			expect(draft).toEqual(stored)
			expect(app.store.put).not.toHaveBeenCalled()
		})
	})

	describe('sendMessage', () => {
		it('Runs an engine turn, appends both messages and stores open questions', async () => {
			// Arrange
			vi.spyOn(app.store, 'get').mockResolvedValue(createEmptyDraft('order-1', 'org-1'))

			// Act
			const draft = await app.specService.sendMessage('order-1', 'I want a booking app', user)

			// Assert
			expect(app.anthropic.messages.create).toHaveBeenCalledTimes(1)
			expect(draft.status).toBe('drafting')
			expect(draft.spec).toEqual({
				goal: 'A booking app for a small gym with 200 members',
				users: ['members'],
			})
			expect(draft.openQuestions).toEqual(['Which features do you need?'])
			expect(draft.priceSek).toBeUndefined()
			expect(draft.messages.map(m => [m.role, m.content])).toEqual([
				['user', 'I want a booking app'],
				['assistant', 'Got it. A couple of questions...'],
			])
			expect(app.store.put).toHaveBeenCalledWith('specs', 'order-1', draft)
		})

		it('Marks the draft ready with an estimated price when the spec becomes complete', async () => {
			// Arrange
			vi.spyOn(app.store, 'get').mockResolvedValue(createMockSpecDraft({ orderId: 'order-1' }))
			vi.spyOn(app.anthropic.messages, 'create').mockResolvedValue(
				createMockToolUseMessage(
					createMockSpecToolOutput({
						...createMockSpec(),
						nonGoalsAnswered: true,
						stackConstraintsAnswered: true,
						questions: [],
						assistantMessage: 'Complete — please review and freeze.',
					})
				)
			)

			// Act
			const draft = await app.specService.sendMessage(
				'order-1',
				'No payments, no constraints',
				user
			)

			// Assert
			expect(draft.status).toBe('ready')
			expect(draft.openQuestions).toEqual([])
			expect(draft.spec.sizeClass).toBe('S')
			expect(draft.priceSek).toBe(15_000)
			expect(draft.messages).toHaveLength(4)
		})

		it('Rejects messages on a frozen draft', async () => {
			// Arrange
			vi.spyOn(app.store, 'get').mockResolvedValue(createMockSpecDraft({ status: 'frozen' }))

			// Act & Assert
			await expect(app.specService.sendMessage('order-1', 'more', user)).rejects.toBeInstanceOf(
				EntityInvalid
			)
			expect(app.anthropic.messages.create).not.toHaveBeenCalled()
		})

		it('Propagates engine failures without storing anything', async () => {
			// Arrange
			vi.spyOn(app.store, 'get').mockResolvedValue(createEmptyDraft('order-1', 'org-1'))
			vi.spyOn(app.anthropic.messages, 'create').mockRejectedValue(new Error('rate limited'))

			// Act & Assert
			await expect(app.specService.sendMessage('order-1', 'hi', user)).rejects.toThrow(
				'rate limited'
			)
			expect(app.store.put).not.toHaveBeenCalled()
		})
	})

	describe('freeze', () => {
		it('Rejects an incomplete draft', async () => {
			// Arrange
			vi.spyOn(app.store, 'get').mockResolvedValue(createMockSpecDraft())

			// Act & Assert
			await expect(app.specService.freeze('order-1', user)).rejects.toBeInstanceOf(EntityInvalid)
			expect(app.store.put).not.toHaveBeenCalled()
		})

		it('Freezes a complete draft with size class, price and timestamp', async () => {
			// Arrange
			const ready = createMockSpecDraft({ status: 'ready', spec: createMockSpec() })
			vi.spyOn(app.store, 'get').mockResolvedValue(ready)

			// Act
			const frozen = await app.specService.freeze('order-1', user)

			// Assert
			expect(frozen).toEqual({
				...ready,
				status: 'frozen',
				spec: { ...ready.spec, sizeClass: 'S' },
				openQuestions: [],
				priceSek: 15_000,
				frozenAt: expect.any(String),
			})
			expect(app.store.put).toHaveBeenCalledWith('specs', 'order-1', frozen)
		})

		it('Is idempotent for an already frozen draft', async () => {
			// Arrange
			const frozen = createMockSpecDraft({ status: 'frozen', frozenAt: '2026-08-26T00:00:00.000Z' })
			vi.spyOn(app.store, 'get').mockResolvedValue(frozen)

			// Act
			const result = await app.specService.freeze('order-1', user)

			// Assert
			expect(result).toEqual(frozen)
			expect(app.store.put).not.toHaveBeenCalled()
		})
	})
})

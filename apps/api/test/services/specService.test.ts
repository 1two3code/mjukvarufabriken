import { EntityInvalid, EntityNotFound } from '#/lib/entityError.ts'
import {
	createMockSpecToolOutput,
	createMockToolUseMessage,
} from '#/plugins/__mocks__/anthropic.ts'
import { createMockSpec, createMockSpecDraft } from '#/services/__mocks__/specService.ts'
import {
	createEmptyDraft,
	specChatLimits,
	specChatRateLimitScope,
	SpecRateLimited,
	SpecTurnLimitReached,
} from '#/services/specService.ts'

import type { FastifyInstance } from 'fastify'
import type { BackendSession, SpecDraft } from '@mf/models'

const user: BackendSession = { userId: 'user-1', role: 'user', orgId: 'org-1' }
const admin: BackendSession = { userId: 'admin-1', role: 'admin', orgId: 'org-admin' }

describe('Spec Service', () => {
	let app: FastifyInstance

	/** Seeds the (in-memory) orders repository and spies on writes */
	const seed = async (draft: SpecDraft) => {
		await app.db.orders.upsert(draft)
		vi.spyOn(app.db.orders, 'upsert')
		vi.spyOn(app.db.orders, 'updateUnlessFrozen')
		return draft
	}

	beforeEach(async () => {
		app = await createTestApp({ skipMock: '#/services/specService.ts' })
	})

	describe('get', () => {
		it('Is not found for an unknown order id and never creates a draft', async () => {
			// Arrange
			vi.spyOn(app.db.orders, 'upsert')

			// Act / Assert
			await expect(app.specService.get('order-9', user)).rejects.toBeInstanceOf(EntityNotFound)
			await expect(app.specService.get('order-9', admin)).rejects.toBeInstanceOf(EntityNotFound)
			await expect(app.specService.sendMessage('order-9', 'hi', user)).rejects.toBeInstanceOf(
				EntityNotFound
			)
			await expect(app.specService.freeze('order-9', user)).rejects.toBeInstanceOf(EntityNotFound)
			expect(app.db.orders.upsert).not.toHaveBeenCalled()
			await expect(app.db.orders.get('order-9')).resolves.toBeUndefined()
		})

		it("Hides another org's draft as not found, but admins see it", async () => {
			// Arrange
			await seed(createMockSpecDraft({ orderId: 'order-1', orgId: 'org-2' }))

			// Act / Assert
			await expect(app.specService.get('order-1', user)).rejects.toBeInstanceOf(EntityNotFound)
			await expect(app.specService.sendMessage('order-1', 'hi', user)).rejects.toBeInstanceOf(
				EntityNotFound
			)
			await expect(app.specService.freeze('order-1', user)).rejects.toBeInstanceOf(EntityNotFound)
			await expect(app.specService.get('order-1', admin)).resolves.toMatchObject({
				orgId: 'org-2',
			})
			expect(app.db.orders.upsert).not.toHaveBeenCalled()
		})

		it('Returns the stored draft', async () => {
			// Arrange
			const stored = await seed(createMockSpecDraft({ orderId: 'order-1' }))
			vi.spyOn(app.db.orders, 'get')

			// Act
			const draft = await app.specService.get('order-1', user)

			// Assert
			expect(app.db.orders.get).toHaveBeenCalledWith('order-1')
			expect(draft).toEqual(stored)
			expect(app.db.orders.upsert).not.toHaveBeenCalled()
		})
	})

	describe('sendMessage', () => {
		it('Runs an engine turn, appends both messages and stores open questions', async () => {
			// Arrange
			await seed(createEmptyDraft('order-1', 'org-1'))

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
			await expect(app.db.orders.get('order-1')).resolves.toEqual(draft)
		})

		it('Marks the draft ready with an estimated price when the spec becomes complete', async () => {
			// Arrange
			await seed(createMockSpecDraft({ orderId: 'order-1' }))
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
			expect(draft.priceSek).toBe(3_000)
			expect(draft.messages).toHaveLength(4)
		})

		it('Rejects messages on a frozen draft', async () => {
			// Arrange
			await seed(createMockSpecDraft({ status: 'frozen' }))

			// Act & Assert
			await expect(app.specService.sendMessage('order-1', 'more', user)).rejects.toBeInstanceOf(
				EntityInvalid
			)
			expect(app.anthropic.messages.create).not.toHaveBeenCalled()
		})

		it('Does not undo a freeze that completed while the engine was running', async () => {
			// Arrange
			const seeded = await seed(createMockSpecDraft({ orderId: 'order-1', status: 'ready' }))
			vi.spyOn(app.anthropic.messages, 'create').mockImplementation(async () => {
				// The user clicked Freeze in another tab during the engine call
				await app.db.orders.upsert({
					...seeded,
					status: 'frozen',
					frozenAt: '2026-08-26T12:00:00.000Z',
				})
				return createMockToolUseMessage(createMockSpecToolOutput({ questions: ['Which stack?'] }))
			})

			// Act & Assert
			await expect(
				app.specService.sendMessage('order-1', 'change it', user)
			).rejects.toBeInstanceOf(EntityInvalid)
			await expect(app.db.orders.get('order-1')).resolves.toMatchObject({
				status: 'frozen',
				frozenAt: '2026-08-26T12:00:00.000Z',
				messages: seeded.messages,
			})
		})

		it('Propagates engine failures without storing anything', async () => {
			// Arrange
			await seed(createEmptyDraft('order-1', 'org-1'))
			vi.spyOn(app.anthropic.messages, 'create').mockRejectedValue(new Error('rate limited'))

			// Act & Assert
			await expect(app.specService.sendMessage('order-1', 'hi', user)).rejects.toThrow(
				'rate limited'
			)
			expect(app.db.orders.upsert).not.toHaveBeenCalled()
			expect(app.db.orders.updateUnlessFrozen).not.toHaveBeenCalled()
		})
	})

	// MARK: Spend ceilings (audit P1-2)

	describe('sendMessage limits', () => {
		/** A draft with `turns` completed turns already stored (two messages each) */
		const draftWithTurns = (turns: number, overrides: Partial<SpecDraft> = {}): SpecDraft => ({
			...createEmptyDraft('order-1', 'org-1'),
			messages: Array.from({ length: turns * 2 }, (_, index) => ({
				role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
				content: `m${index}`,
				createdAt: '2026-08-26T10:00:00.000Z',
			})),
			...overrides,
		})

		it('Refuses a turn once the draft has used its lifetime turn budget, before any model call', async () => {
			// Arrange
			await seed(draftWithTurns(specChatLimits.maxTurns))

			// Act & Assert
			await expect(app.specService.sendMessage('order-1', 'more', user)).rejects.toBeInstanceOf(
				SpecTurnLimitReached
			)
			expect(app.anthropic.messages.create).not.toHaveBeenCalled()
			expect(app.db.orders.updateUnlessFrozen).not.toHaveBeenCalled()
		})

		it('Still allows the last turn under the budget', async () => {
			// Arrange
			await seed(draftWithTurns(specChatLimits.maxTurns - 1))

			// Act & Assert
			await expect(app.specService.sendMessage('order-1', 'more', user)).resolves.toBeDefined()
			expect(app.anthropic.messages.create).toHaveBeenCalledTimes(1)
		})

		it('Counts every turn against both the order and the org window', async () => {
			// Arrange
			await seed(createEmptyDraft('order-1', 'org-1'))
			vi.spyOn(app.db.rateLimits, 'record')

			// Act
			await app.specService.sendMessage('order-1', 'hi', user)

			// Assert
			expect(app.db.rateLimits.record).toHaveBeenCalledWith(
				specChatRateLimitScope.order,
				'order-1',
				expect.any(Date)
			)
			expect(app.db.rateLimits.record).toHaveBeenCalledWith(
				specChatRateLimitScope.org,
				'org-1',
				expect.any(Date)
			)
		})

		it('Rate limits a burst on one order without spending a model call', async () => {
			// Arrange — the order's window is already full
			await seed(createEmptyDraft('order-1', 'org-1'))
			const now = new Date()
			for (let i = 0; i < specChatLimits.maxTurnsPerOrder; i++) {
				await app.db.rateLimits.record(specChatRateLimitScope.order, 'order-1', now)
			}

			// Act & Assert
			await expect(app.specService.sendMessage('order-1', 'hi', user)).rejects.toBeInstanceOf(
				SpecRateLimited
			)
			expect(app.anthropic.messages.create).not.toHaveBeenCalled()
		})

		it('Rate limits per org too, so minting fresh orders does not bypass the ceiling', async () => {
			// Arrange — a brand new order, but the org has already used its window on other orders
			await seed(createEmptyDraft('order-new', 'org-1'))
			const now = new Date()
			for (let i = 0; i < specChatLimits.maxTurnsPerOrg; i++) {
				await app.db.rateLimits.record(specChatRateLimitScope.org, 'org-1', now)
			}

			// Act & Assert
			await expect(app.specService.sendMessage('order-new', 'hi', user)).rejects.toBeInstanceOf(
				SpecRateLimited
			)
			expect(app.anthropic.messages.create).not.toHaveBeenCalled()
		})

		it("Bills an admin's turn to the draft's org, not to the admin's own", async () => {
			// Arrange
			await seed(createMockSpecDraft({ orderId: 'order-1', orgId: 'org-2', messages: [] }))
			vi.spyOn(app.db.rateLimits, 'record')

			// Act
			await app.specService.sendMessage('order-1', 'hi', admin)

			// Assert
			expect(app.db.rateLimits.record).toHaveBeenCalledWith(
				specChatRateLimitScope.org,
				'org-2',
				expect.any(Date)
			)
			expect(app.db.rateLimits.record).not.toHaveBeenCalledWith(
				specChatRateLimitScope.org,
				'org-admin',
				expect.any(Date)
			)
		})

		it('Counts a turn that then fails, so a broken engine is not an unlimited free retry', async () => {
			// Arrange
			await seed(createEmptyDraft('order-1', 'org-1'))
			vi.spyOn(app.anthropic.messages, 'create').mockRejectedValue(new Error('boom'))
			const since = new Date(Date.now() - 60_000)

			// Act
			await expect(app.specService.sendMessage('order-1', 'hi', user)).rejects.toThrow('boom')

			// Assert
			await expect(
				app.db.rateLimits.count(specChatRateLimitScope.order, 'order-1', since)
			).resolves.toBe(1)
		})

		it('Rate limits globally, so minting fresh orgs does not bypass the ceiling either', async () => {
			// Arrange — a brand new org (sign-up is open and free, so this costs an abuser nothing),
			// but the deployment as a whole has already used its window on other orgs
			const fresh: BackendSession = { userId: 'user-fresh', role: 'user', orgId: 'org-fresh' }
			await seed(createEmptyDraft('order-new', 'org-fresh'))
			const now = new Date()
			for (let i = 0; i < specChatLimits.maxTurnsGlobal; i++) {
				await app.db.rateLimits.record(specChatRateLimitScope.org, `org-${i}`, now)
			}

			// Act & Assert
			await expect(app.specService.sendMessage('order-new', 'hi', fresh)).rejects.toBeInstanceOf(
				SpecRateLimited
			)
			expect(app.anthropic.messages.create).not.toHaveBeenCalled()
		})

		it('Records the hit before counting, so a concurrent burst cannot outrun the ceiling', async () => {
			// Arrange — one order, far more concurrent turns than its window allows
			await seed(createEmptyDraft('order-1', 'org-1'))
			const burst = specChatLimits.maxTurnsPerOrder * 2

			// Act — all of them are in flight before any of them finishes
			const results = await Promise.allSettled(
				Array.from({ length: burst }, () => app.specService.sendMessage('order-1', 'hi', user))
			)

			// Assert — with a count-then-record limiter every one of these would read a count of 0,
			// pass, and spend a paid model call. Recording first makes the race over-count instead.
			expect(vi.mocked(app.anthropic.messages.create).mock.calls.length).toBeLessThanOrEqual(
				specChatLimits.maxTurnsPerOrder
			)
			expect(
				results.filter(
					result => result.status === 'rejected' && result.reason instanceof SpecRateLimited
				).length
			).toBeGreaterThanOrEqual(burst - specChatLimits.maxTurnsPerOrder)
		})
	})

	describe('freeze', () => {
		it('Rejects an incomplete draft', async () => {
			// Arrange
			await seed(createMockSpecDraft())

			// Act & Assert
			await expect(app.specService.freeze('order-1', user)).rejects.toBeInstanceOf(EntityInvalid)
			expect(app.db.orders.upsert).not.toHaveBeenCalled()
		})

		it('Freezes a complete draft with size class, price and timestamp', async () => {
			// Arrange
			const ready = await seed(createMockSpecDraft({ status: 'ready', spec: createMockSpec() }))

			// Act
			const frozen = await app.specService.freeze('order-1', user)

			// Assert
			expect(frozen).toEqual({
				...ready,
				status: 'frozen',
				spec: { ...ready.spec, sizeClass: 'S' },
				openQuestions: [],
				priceSek: 3_000,
				frozenAt: expect.any(String),
			})
			await expect(app.db.orders.get('order-1')).resolves.toEqual(frozen)
		})

		it('Reads the build price from the pricing_tiers table when seeded', async () => {
			// Arrange: an admin repriced the S build; the latest effective row wins over the default
			await app.db.pricingTiers.insert({
				tierKey: 'build_s',
				name: 'Build (small)',
				price: 2_500,
				currency: 'SEK',
				description: '',
				effectiveFrom: '2026-08-31T00:00:00.000Z',
			})
			await seed(createMockSpecDraft({ status: 'ready', spec: createMockSpec() }))

			// Act
			const frozen = await app.specService.freeze('order-1', user)

			// Assert
			expect(frozen.priceSek).toBe(2_500)
		})

		it('Prices a voucher demo at the demo tier whatever its size class, on the turn and at freeze', async () => {
			// Arrange: a demo order whose spec classifies as M (4 plain features) — the class is
			// stored (it sizes the build budget) but the price is the demo tier's, never build_m
			await app.db.orders.insert({ id: 'order-1', orgId: 'org-1', name: 'demo', kind: 'demo' })
			await app.db.pricingTiers.insert({
				tierKey: 'demo',
				name: 'Demo',
				price: 450,
				currency: 'SEK',
				description: '',
				effectiveFrom: '2026-08-31T00:00:00.000Z',
			})
			const feature = (title: string) => ({
				title,
				description: '',
				acceptanceCriteria: [`${title} works`],
			})
			const spec = createMockSpec({
				features: [feature('Book'), feature('Cancel'), feature('Waitlist'), feature('Remind')],
			})
			await seed(createMockSpecDraft({ orderId: 'order-1', spec }))
			vi.spyOn(app.anthropic.messages, 'create').mockResolvedValue(
				createMockToolUseMessage(
					createMockSpecToolOutput({
						...spec,
						nonGoalsAnswered: true,
						stackConstraintsAnswered: true,
						questions: [],
						assistantMessage: 'Complete — please review and freeze.',
					})
				)
			)

			// Act
			const ready = await app.specService.sendMessage('order-1', 'That is all', user)
			const frozen = await app.specService.freeze('order-1', user)

			// Assert
			expect(ready.status).toBe('ready')
			expect(ready.priceSek).toBe(450)
			expect(frozen.spec.sizeClass).toBe('M')
			expect(frozen.priceSek).toBe(450)
			await expect(app.db.orders.getOrder('order-1')).resolves.toMatchObject({
				kind: 'demo',
				sizeClass: 'M',
				priceSek: 450,
			})
		})

		it('Falls back to 500 kr for a demo when the tiers table has no demo row', async () => {
			// Arrange
			await app.db.orders.insert({ id: 'order-1', orgId: 'org-1', name: 'demo', kind: 'demo' })
			await seed(createMockSpecDraft({ status: 'ready', spec: createMockSpec() }))

			// Act
			const frozen = await app.specService.freeze('order-1', user)

			// Assert
			expect(frozen).toMatchObject({ status: 'frozen', priceSek: 500 })
			expect(frozen.spec.sizeClass).toBe('S')
		})

		it('Is idempotent for an already frozen draft', async () => {
			// Arrange
			const frozen = await seed(
				createMockSpecDraft({ status: 'frozen', frozenAt: '2026-08-26T00:00:00.000Z' })
			)

			// Act
			const result = await app.specService.freeze('order-1', user)

			// Assert
			expect(result).toEqual(frozen)
			expect(app.db.orders.upsert).not.toHaveBeenCalled()
		})
	})
})

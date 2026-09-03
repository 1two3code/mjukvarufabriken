import { isAnonymousOrgId } from '@mf/models'

import { EntityNotFound } from '#/lib/entityError.ts'
import {
	createMockSpecToolOutput,
	createMockToolUseMessage,
} from '#/plugins/__mocks__/anthropic.ts'
import { createMockSpec } from '#/services/__mocks__/specService.ts'
import {
	anonymousQuoteRetentionDays,
	quoteRateLimit,
	QuoteRateLimited,
	quoteRateLimitScope,
	quoteRetentionCutoff,
} from '#/services/quoteService.ts'
import { hashQuoteToken } from '#/services/quoteService.utils.ts'
import { specChatLimits, specChatRateLimitScope, SpecRateLimited } from '#/services/specService.ts'

import type { FastifyInstance } from 'fastify'
import type { BackendSession } from '@mf/models'

const ip = '203.0.113.7'
const user: BackendSession = { userId: 'user-1', role: 'user', orgId: 'org-1' }
const admin: BackendSession = { userId: 'admin-1', role: 'admin', orgId: 'org-admin' }

/**
 * The real quote + spec services (the engine is the mocked Anthropic client), plus the real
 * order, payment and job services so the "doors shut" suite proves every door with its actual
 * org check rather than a mock. One list for the whole file: `vi.doMock` persists per file, so
 * a nested `createTestApp` cannot un-mock what an outer one mocked.
 */
const realServices = [
	'#/services/quoteService.ts',
	'#/services/specService.ts',
	'#/services/orderService.ts',
	'#/services/paymentService.ts',
	'#/services/jobService.ts',
]

describe('Quote Service (anonymous spec chat, wave 14 F1)', () => {
	let app: FastifyInstance

	beforeEach(async () => {
		app = await createTestApp({ skipMock: realServices })
		vi.spyOn(app.db.jobs, 'list').mockResolvedValue([])
	})

	/** A canned engine reply that completes the spec on this turn */
	const completeTurn = () =>
		vi.spyOn(app.anthropic.messages, 'create').mockResolvedValue(
			createMockToolUseMessage(
				createMockSpecToolOutput({
					...createMockSpec(),
					nonGoalsAnswered: true,
					stackConstraintsAnswered: true,
					questions: [],
					assistantMessage: 'Complete — here is your quote.',
				})
			)
		)

	// MARK: create

	describe('create', () => {
		it('Mints an anonymous order and returns the token once, storing only its hash', async () => {
			const { quote, token } = await app.quoteService.create(ip)

			expect(token).toMatch(/^[0-9a-f]{64}$/)
			expect(quote).toEqual({
				orderId: expect.stringMatching(/^[0-9a-f-]{36}$/),
				status: 'drafting',
				spec: {},
				messages: [],
				openQuestions: [],
				complete: false,
				priceSek: undefined,
				sizeClass: undefined,
			})
			const order = await app.db.orders.getOrder(quote.orderId)
			expect(isAnonymousOrgId(order?.orgId)).toBe(true)
			expect(order?.createdBy).toBeUndefined()
			expect(order).not.toHaveProperty('quoteTokenHash')
			// The row is found by the hash of the token, not the token
			await expect(
				app.db.orders.getOrderByQuoteToken(quote.orderId, hashQuoteToken(token))
			).resolves.toBeDefined()
			await expect(
				app.db.orders.getOrderByQuoteToken(quote.orderId, token)
			).resolves.toBeUndefined()
		})

		it('Uses the given name (the site passes its localized default)', async () => {
			const { quote } = await app.quoteService.create(ip, 'Quote')
			await expect(app.db.orders.getOrder(quote.orderId)).resolves.toMatchObject({ name: 'Quote' })
		})

		it('Rate limits quote creation per ip, recording the hit before counting', async () => {
			for (let i = 0; i < quoteRateLimit.create; i++) await app.quoteService.create(ip)

			await expect(app.quoteService.create(ip)).rejects.toBeInstanceOf(QuoteRateLimited)
			await expect(app.quoteService.create('198.51.100.1')).resolves.toBeDefined()
			const since = new Date(Date.now() - 60_000)
			await expect(app.db.rateLimits.count(quoteRateLimitScope.create, ip, since)).resolves.toBe(
				quoteRateLimit.create + 1
			)
		})
	})

	// MARK: get (token verification)

	describe('get', () => {
		it('Returns the quote for the right token and hides everything else as not found', async () => {
			const { quote, token } = await app.quoteService.create(ip)

			await expect(app.quoteService.get(quote.orderId, token, ip)).resolves.toEqual(quote)
			await expect(app.quoteService.get(quote.orderId, 'b'.repeat(64), ip)).rejects.toBeInstanceOf(
				EntityNotFound
			)
			await expect(app.quoteService.get('missing', token, ip)).rejects.toBeInstanceOf(
				EntityNotFound
			)
		})

		it('Never returns an ordinary (org-owned) order, whatever the token', async () => {
			const order = await app.db.orders.insert({ id: 'order-1', orgId: 'org-1', name: 'Mine' })

			await expect(app.quoteService.get(order.id, 'a'.repeat(64), ip)).rejects.toBeInstanceOf(
				EntityNotFound
			)
		})

		it('Rate limits reads per ip', async () => {
			const { quote, token } = await app.quoteService.create(ip)
			const now = new Date()
			for (let i = 0; i < quoteRateLimit.read; i++) {
				await app.db.rateLimits.record(quoteRateLimitScope.read, ip, now)
			}

			await expect(app.quoteService.get(quote.orderId, token, ip)).rejects.toBeInstanceOf(
				QuoteRateLimited
			)
		})
	})

	// MARK: sendMessage (the shared engine turn)

	describe('sendMessage', () => {
		it('Runs an engine turn through specService and returns the quote view of the draft', async () => {
			const { quote, token } = await app.quoteService.create(ip)
			vi.spyOn(app.specService, 'runTurn')

			const updated = await app.quoteService.sendMessage(
				quote.orderId,
				token,
				'I want a booking app',
				ip
			)

			expect(app.anthropic.messages.create).toHaveBeenCalledTimes(1)
			expect(app.specService.runTurn).toHaveBeenCalledWith(
				expect.objectContaining({ orderId: quote.orderId }),
				'I want a booking app',
				{ orgId: expect.stringMatching(/^anon:[0-9a-f]{32}$/), ip }
			)
			expect(updated).toMatchObject({
				orderId: quote.orderId,
				status: 'drafting',
				complete: false,
				openQuestions: ['Which features do you need?'],
			})
			expect(updated.messages.map(m => m.role)).toEqual(['user', 'assistant'])
			expect(updated).not.toHaveProperty('orgId')
		})

		it('Refuses a turn with a wrong token before any model call', async () => {
			const { quote } = await app.quoteService.create(ip)

			await expect(
				app.quoteService.sendMessage(quote.orderId, 'b'.repeat(64), 'hi', ip)
			).rejects.toBeInstanceOf(EntityNotFound)
			expect(app.anthropic.messages.create).not.toHaveBeenCalled()
		})

		it('Fixes the quote (price + size class) on the turn that completes the spec', async () => {
			const { quote, token } = await app.quoteService.create(ip)
			completeTurn()

			const updated = await app.quoteService.sendMessage(quote.orderId, token, 'all of it', ip)

			expect(updated).toMatchObject({
				status: 'ready',
				complete: true,
				priceSek: 3_000,
				sizeClass: 'S',
				openQuestions: [],
			})
		})

		it('Resumes after a turn: the token still opens the draft and a second turn follows', async () => {
			const { quote, token } = await app.quoteService.create(ip)
			await app.quoteService.sendMessage(quote.orderId, token, 'I want a booking app', ip)

			// The site's refresh path: read the stored handle back, then keep chatting
			const resumed = await app.quoteService.get(quote.orderId, token, ip)
			expect(resumed.messages.map(m => m.role)).toEqual(['user', 'assistant'])

			const second = await app.quoteService.sendMessage(quote.orderId, token, 'For a gym', ip)
			expect(second.messages.map(m => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
			expect(app.anthropic.messages.create).toHaveBeenCalledTimes(2)
		})

		it('Counts every anonymous turn against the ip window on top of order/org/global', async () => {
			const { quote, token } = await app.quoteService.create(ip)
			vi.spyOn(app.db.rateLimits, 'record')

			await app.quoteService.sendMessage(quote.orderId, token, 'hi', ip)

			expect(app.db.rateLimits.record).toHaveBeenCalledWith(
				specChatRateLimitScope.ip,
				ip,
				expect.any(Date)
			)
			expect(app.db.rateLimits.record).toHaveBeenCalledWith(
				specChatRateLimitScope.order,
				quote.orderId,
				expect.any(Date)
			)
			expect(app.db.rateLimits.record).toHaveBeenCalledWith(
				specChatRateLimitScope.org,
				expect.stringMatching(/^anon:/),
				expect.any(Date)
			)
		})

		it('Rate limits per ip, so minting fresh quotes does not buy more turns', async () => {
			const { quote, token } = await app.quoteService.create(ip)
			const now = new Date()
			for (let i = 0; i < specChatLimits.maxTurnsPerIp; i++) {
				await app.db.rateLimits.record(specChatRateLimitScope.ip, ip, now)
			}

			await expect(
				app.quoteService.sendMessage(quote.orderId, token, 'hi', ip)
			).rejects.toBeInstanceOf(SpecRateLimited)
			expect(app.anthropic.messages.create).not.toHaveBeenCalled()
		})

		it('Shares the global spec ceiling with the portal: a full deployment window refuses anonymous turns too', async () => {
			const { quote, token } = await app.quoteService.create(ip)
			const now = new Date()
			for (let i = 0; i < specChatLimits.maxTurnsGlobal; i++) {
				await app.db.rateLimits.record(specChatRateLimitScope.org, `org-${i}`, now)
			}

			await expect(
				app.quoteService.sendMessage(quote.orderId, token, 'hi', ip)
			).rejects.toBeInstanceOf(SpecRateLimited)
			expect(app.anthropic.messages.create).not.toHaveBeenCalled()
		})

		it('And the other way round: anonymous turns eat into the ceiling the portal chat sees', async () => {
			const { quote, token } = await app.quoteService.create(ip)
			await app.quoteService.sendMessage(quote.orderId, token, 'hi', ip)
			const since = new Date(Date.now() - 60_000)

			await expect(
				app.db.rateLimits.count(specChatRateLimitScope.org, undefined, since)
			).resolves.toBe(1)
		})
	})

	// MARK: Doors shut — an anonymous order can never be frozen, paid, built or listed

	describe('doors shut for every session until claimed', () => {
		it('specService.get / sendMessage / freeze are not found — for the org and for admins', async () => {
			const { quote } = await app.quoteService.create(ip)

			for (const session of [user, admin]) {
				await expect(app.specService.get(quote.orderId, session)).rejects.toBeInstanceOf(
					EntityNotFound
				)
				await expect(
					app.specService.sendMessage(quote.orderId, 'hi', session)
				).rejects.toBeInstanceOf(EntityNotFound)
				await expect(app.specService.freeze(quote.orderId, session)).rejects.toBeInstanceOf(
					EntityNotFound
				)
			}
			expect(app.anthropic.messages.create).not.toHaveBeenCalled()
			await expect(app.db.orders.get(quote.orderId)).resolves.toMatchObject({ status: 'drafting' })
		})

		it('Cannot be frozen even with a complete spec', async () => {
			const { quote, token } = await app.quoteService.create(ip)
			completeTurn()
			await app.quoteService.sendMessage(quote.orderId, token, 'all of it', ip)

			await expect(app.specService.freeze(quote.orderId, admin)).rejects.toBeInstanceOf(
				EntityNotFound
			)
			await expect(app.db.orders.getOrder(quote.orderId)).resolves.toMatchObject({
				status: 'ready',
				frozenAt: undefined,
			})
		})
	})

	describe('doors shut: order, payment and build services', () => {
		it('orderService.get / getDetail are not found for the org and for admins', async () => {
			const { quote } = await app.quoteService.create(ip)

			for (const session of [user, admin]) {
				await expect(app.orderService.get(quote.orderId, session)).rejects.toBeInstanceOf(
					EntityNotFound
				)
				await expect(app.orderService.getDetail(quote.orderId, session)).rejects.toBeInstanceOf(
					EntityNotFound
				)
			}
		})

		it('orderService.list never shows anonymous quotes — not to an org, not to an admin', async () => {
			await app.quoteService.create(ip)
			const mine = await app.orderService.create('Mine', user)

			expect((await app.orderService.list(user)).map(order => order.id)).toEqual([mine.id])
			expect((await app.orderService.list(admin)).map(order => order.id)).toEqual([mine.id])
		})

		it('paymentService.checkout is not found (nothing to pay for)', async () => {
			const { quote, token } = await app.quoteService.create(ip)
			completeTurn()
			await app.quoteService.sendMessage(quote.orderId, token, 'all of it', ip)

			await expect(
				app.paymentService.checkout(quote.orderId, 'deposit', admin)
			).rejects.toBeInstanceOf(EntityNotFound)
			expect(app.paymentProvider.createCheckoutSession).not.toHaveBeenCalled()
		})

		it('jobService.start is not found (no job row, no task)', async () => {
			const { quote } = await app.quoteService.create(ip)

			await expect(app.jobService.start(quote.orderId, admin)).rejects.toBeInstanceOf(
				EntityNotFound
			)
			expect(app.db.jobs.insert).not.toHaveBeenCalled()
			expect(app.ecs.runJob).not.toHaveBeenCalled()
		})
	})

	// MARK: Retention sweep

	describe('sweepUnclaimed', () => {
		it('Deletes unclaimed anonymous quotes older than the retention, nothing else', async () => {
			vi.useFakeTimers()
			try {
				vi.setSystemTime(new Date('2026-07-01T00:00:00.000Z'))
				const { quote: old } = await app.quoteService.create(ip)
				const kept = await app.db.orders.insert({ id: 'real', orgId: 'org-1', name: 'Mine' })
				vi.setSystemTime(new Date('2026-09-01T00:00:00.000Z'))
				const { quote: fresh } = await app.quoteService.create('198.51.100.1')

				const deleted = await app.quoteService.sweepUnclaimed()

				expect(deleted).toBe(1)
				await expect(app.db.orders.getOrder(old.orderId)).resolves.toBeUndefined()
				await expect(app.db.orders.getOrder(kept.id)).resolves.toBeDefined()
				await expect(app.db.orders.getOrder(fresh.orderId)).resolves.toBeDefined()
			} finally {
				vi.useRealTimers()
			}
		})

		it('Cuts off exactly the retention window before now', () => {
			const now = new Date('2026-09-01T00:00:00.000Z')
			const cutoff = quoteRetentionCutoff(now)
			expect((now.getTime() - cutoff.getTime()) / (24 * 60 * 60 * 1000)).toBe(
				anonymousQuoteRetentionDays
			)
		})
	})
})

import { EntityNotFound } from '#/lib/entityError.ts'
import { createMockJob } from '#/plugins/__mocks__/db.ts'
import { InvalidOrderTransition, transitionSources } from '#/services/orderService.ts'

import type { FastifyInstance } from 'fastify'
import type { BackendSession, OrderStatus } from '@mf/models'

const user: BackendSession = { userId: 'user-1', role: 'user', orgId: 'org-1' }
const other: BackendSession = { userId: 'user-2', role: 'user', orgId: 'org-2' }
const admin: BackendSession = { userId: 'admin-1', role: 'admin', orgId: 'org-admin' }

describe('Order Service', () => {
	let app: FastifyInstance

	beforeEach(async () => {
		app = await createTestApp({ skipMock: '#/services/orderService.ts' })
		vi.spyOn(app.db.jobs, 'list').mockResolvedValue([])
	})

	describe('create / list / get', () => {
		it('Mints a uuid and creates a drafting order for the org', async () => {
			const order = await app.orderService.create('Gym booking', user)

			expect(order).toMatchObject({
				id: expect.stringMatching(/^[0-9a-f-]{36}$/),
				orgId: 'org-1',
				name: 'Gym booking',
				status: 'drafting',
			})
			await expect(app.db.orders.get(order.id)).resolves.toMatchObject({
				orderId: order.id,
				status: 'drafting',
				spec: {},
			})
		})

		it('Scopes list and get to the org; admins see every org', async () => {
			const mine = await app.orderService.create('mine', user)
			const theirs = await app.orderService.create('theirs', other)

			expect((await app.orderService.list(user)).map(order => order.id)).toEqual([mine.id])
			expect((await app.orderService.list(admin)).map(order => order.id).sort()).toEqual(
				[mine.id, theirs.id].sort()
			)
			await expect(app.orderService.get(theirs.id, user)).rejects.toBeInstanceOf(EntityNotFound)
			await expect(app.orderService.get(theirs.id, admin)).resolves.toMatchObject({ id: theirs.id })
			await expect(app.orderService.get('missing', user)).rejects.toBeInstanceOf(EntityNotFound)
		})
	})

	describe('transition (state machine)', () => {
		const walk = async (id: string, path: OrderStatus[]) => {
			for (const status of path) await app.orderService.transition(id, status)
		}

		it('Follows drafting → ready → frozen → deposit_paid → building → delivered → paid', async () => {
			const { id } = await app.orderService.create('x', user)
			await walk(id, ['ready', 'frozen', 'deposit_paid', 'building', 'delivered', 'paid'])
			await expect(app.orderService.get(id, user)).resolves.toMatchObject({ status: 'paid' })
		})

		it('Rejects illegal transitions with InvalidOrderTransition', async () => {
			const { id } = await app.orderService.create('x', user)
			await expect(app.orderService.transition(id, 'deposit_paid')).rejects.toBeInstanceOf(
				InvalidOrderTransition
			)
			await expect(app.orderService.transition(id, 'building')).rejects.toMatchObject({
				from: 'drafting',
				to: 'building',
			})
			await walk(id, ['ready', 'frozen', 'deposit_paid', 'building', 'delivered', 'paid'])
			await expect(app.orderService.transition(id, 'cancelled')).rejects.toBeInstanceOf(
				InvalidOrderTransition
			)
			await expect(app.orderService.transition('missing', 'ready')).rejects.toBeInstanceOf(
				EntityNotFound
			)
		})

		it('Loses cleanly when the status changed between read and write', async () => {
			const { id } = await app.orderService.create('x', user)
			vi.spyOn(app.db.orders, 'transition').mockResolvedValueOnce(undefined)
			await expect(app.orderService.transition(id, 'ready')).rejects.toBeInstanceOf(
				InvalidOrderTransition
			)
		})

		it('transitionSources inverts the transition table', () => {
			expect(transitionSources('cancelled')).toEqual([
				'drafting',
				'ready',
				'frozen',
				'deposit_paid',
				'building',
			])
			expect(transitionSources('paid')).toEqual(['delivered'])
			expect(transitionSources('drafting')).toEqual(['ready'])
		})
	})

	describe('cancel', () => {
		const walk = async (id: string, path: OrderStatus[]) => {
			for (const status of path) await app.orderService.transition(id, status)
		}

		it('Cancels the org’s own order until the deposit is paid', async () => {
			const { id } = await app.orderService.create('x', user)
			await expect(app.orderService.cancel(id, other)).rejects.toBeInstanceOf(EntityNotFound)
			await expect(app.orderService.cancel(id, user)).resolves.toMatchObject({
				status: 'cancelled',
			})
			await expect(app.orderService.cancel(id, user)).rejects.toBeInstanceOf(InvalidOrderTransition)
		})

		it('Expires open Checkout sessions so a cancelled order cannot be paid', async () => {
			const { id } = await app.orderService.create('x', user)
			await walk(id, ['ready', 'frozen'])
			await app.db.orders.insertPayment({
				orderId: id,
				kind: 'deposit',
				provider: 'stripe',
				amountSek: 7_500,
				vatSek: 1_875,
				totalSek: 9_375,
				sessionId: 'cs_open',
			})
			vi.mocked(app.paymentProvider.expireSession).mockRejectedValueOnce(new Error('down'))

			// A Stripe hiccup does not undo the cancel
			await expect(app.orderService.cancel(id, user)).resolves.toMatchObject({
				status: 'cancelled',
			})
			expect(app.paymentProvider.expireSession).toHaveBeenCalledWith('cs_open')
		})

		it('Refuses customers after the deposit; admins cancel and the active build is killed', async () => {
			const { id } = await app.orderService.create('x', user)
			await walk(id, ['ready', 'frozen', 'deposit_paid', 'building'])
			vi.spyOn(app.db.jobs, 'list').mockResolvedValue([
				createMockJob({ id: 'job-live', orderId: id, status: 'building' }),
				createMockJob({ id: 'job-old', orderId: id, status: 'failed' }),
			])

			await expect(app.orderService.cancel(id, user)).rejects.toMatchObject({
				from: 'building',
				to: 'cancelled',
			})
			expect(app.jobService.kill).not.toHaveBeenCalled()

			await expect(app.orderService.cancel(id, admin)).resolves.toMatchObject({
				status: 'cancelled',
			})
			expect(app.jobService.kill).toHaveBeenCalledTimes(1)
			expect(app.jobService.kill).toHaveBeenCalledWith('job-live')
		})
	})

	describe('getDetail', () => {
		it('Combines order, spec status, latest job summary and payments', async () => {
			const { id } = await app.orderService.create('x', user)
			const draft = (await app.db.orders.get(id))!
			await app.db.orders.upsert({
				...draft,
				status: 'ready',
				openQuestions: ['a', 'b'],
				priceSek: 15_000,
			})
			const job = createMockJob({ id: 'job-9', orderId: id, status: 'building', tokensUsed: 42 })
			vi.spyOn(app.db.jobs, 'list').mockResolvedValue([job])
			await app.db.orders.insertPayment({
				orderId: id,
				kind: 'deposit',
				provider: 'fake',
				amountSek: 7_500,
				vatSek: 1_875,
				totalSek: 9_375,
				sessionId: 'fake_1',
			})

			const detail = await app.orderService.getDetail(id, user)

			expect(detail.order).toMatchObject({ id, status: 'ready', priceSek: 15_000 })
			expect(detail.spec).toEqual({ status: 'ready', complete: false, openQuestions: 2 })
			expect(detail.latestJob).toEqual({
				id: 'job-9',
				status: 'building',
				tokensUsed: 42,
				budget: job.budget,
				startedAt: undefined,
				finishedAt: undefined,
				createdAt: job.createdAt,
			})
			expect(detail.latestJob).not.toHaveProperty('spec')
			expect(detail.payments).toHaveLength(1)
		})

		it('Moves a building order to delivered once its job has delivered', async () => {
			const { id } = await app.orderService.create('x', user)
			for (const status of ['ready', 'frozen', 'deposit_paid', 'building'] as const) {
				await app.orderService.transition(id, status)
			}
			vi.spyOn(app.db.jobs, 'list').mockResolvedValue([
				createMockJob({ orderId: id, status: 'delivered' }),
			])

			const detail = await app.orderService.getDetail(id, user)

			expect(detail.order.status).toBe('delivered')
			await expect(app.orderService.get(id, user)).resolves.toMatchObject({ status: 'delivered' })
		})

		it("Hides another org's order", async () => {
			const { id } = await app.orderService.create('x', user)
			await expect(app.orderService.getDetail(id, other)).rejects.toBeInstanceOf(EntityNotFound)
		})
	})
})

import { EntityNotFound } from '#/lib/entityError.ts'
import { createMockJob } from '#/plugins/__mocks__/db.ts'
import {
	demoCapWindowMs,
	DemoNotApprovable,
	DemoWeeklyCapReached,
	InvalidOrderTransition,
	transitionSources,
} from '#/services/orderService.ts'

import type { FastifyInstance } from 'fastify'
import type { BackendSession, OrderKind, OrderStatus } from '@mf/models'

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

		it('Creates a real build unless a pricing-ladder kind is given', async () => {
			const build = await app.orderService.create('Gym booking', user)
			const demo = await app.orderService.create('Gym booking', user, 'demo')

			expect(build.kind).toBe('build')
			expect(demo.kind).toBe('demo')
			await expect(app.db.orders.getOrder(demo.id)).resolves.toMatchObject({ kind: 'demo' })
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
				'awaiting_approval',
			])
			expect(transitionSources('delivered')).toEqual(['building', 'awaiting_approval'])
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

	describe('approve-before-deliver gate (W7)', () => {
		const walk = async (id: string, path: OrderStatus[]) => {
			for (const status of path) await app.orderService.transition(id, status)
		}
		const toBuilding = async () => {
			const { id } = await app.orderService.create('x', user)
			await walk(id, ['ready', 'frozen', 'deposit_paid', 'building'])
			return id
		}
		const delivered = (id: string) => [createMockJob({ orderId: id, status: 'delivered' })]

		it('Flag off: a delivered build auto-delivers the order (unchanged flow)', async () => {
			const id = await toBuilding()
			vi.spyOn(app.db.jobs, 'list').mockResolvedValue(delivered(id))

			const detail = await app.orderService.getDetail(id, user)

			expect(detail.order.status).toBe('delivered')
			await expect(app.orderService.get(id, user)).resolves.toMatchObject({
				approveBeforeDeliver: false,
			})
		})

		it('Flag on: a delivered build parks the order in awaiting_approval', async () => {
			const id = await toBuilding()
			await app.db.orders.setApproveBeforeDeliver(id, true)
			vi.spyOn(app.db.jobs, 'list').mockResolvedValue(delivered(id))

			const detail = await app.orderService.getDetail(id, user)

			expect(detail.order.status).toBe('awaiting_approval')
			// The gate only holds until approval; it never regresses back to building on re-read
			await expect(app.orderService.get(id, user)).resolves.toMatchObject({
				status: 'awaiting_approval',
			})
		})

		it('approve moves awaiting_approval → delivered', async () => {
			const id = await toBuilding()
			await app.db.orders.setApproveBeforeDeliver(id, true)
			vi.spyOn(app.db.jobs, 'list').mockResolvedValue(delivered(id))
			await app.orderService.getDetail(id, user)

			await expect(app.orderService.approve(id, user)).resolves.toMatchObject({
				status: 'delivered',
			})
		})

		it('approve rejects when the order is not awaiting approval', async () => {
			const id = await toBuilding()
			await expect(app.orderService.approve(id, user)).rejects.toMatchObject({
				from: 'building',
				to: 'delivered',
			})
		})

		it("approve hides another org's order and 404s the unknown", async () => {
			const id = await toBuilding()
			await app.db.orders.setApproveBeforeDeliver(id, true)
			vi.spyOn(app.db.jobs, 'list').mockResolvedValue(delivered(id))
			await app.orderService.getDetail(id, user)

			await expect(app.orderService.approve(id, other)).rejects.toBeInstanceOf(EntityNotFound)
			await expect(app.orderService.approve('missing', admin)).rejects.toBeInstanceOf(
				EntityNotFound
			)
		})

		it('setApprovalGate toggles the flag, org-scoped', async () => {
			const { id } = await app.orderService.create('x', user)

			await expect(app.orderService.setApprovalGate(id, true, admin)).resolves.toMatchObject({
				approveBeforeDeliver: true,
			})
			await expect(app.orderService.setApprovalGate(id, false, admin)).resolves.toMatchObject({
				approveBeforeDeliver: false,
			})
			await expect(app.orderService.setApprovalGate(id, true, other)).rejects.toBeInstanceOf(
				EntityNotFound
			)
			await expect(app.orderService.setApprovalGate('missing', true, admin)).rejects.toBeInstanceOf(
				EntityNotFound
			)
		})
	})

	describe('full-upfront settlement (pricing ladder 2026-08-31)', () => {
		/** A frozen order priced `priceSek`, walked to `building` */
		const toBuilding = async (priceSek: number) => {
			const { id } = await app.orderService.create('x', user)
			const draft = (await app.db.orders.get(id))!
			await app.db.orders.upsert({ ...draft, status: 'frozen', priceSek })
			await app.orderService.transition(id, 'deposit_paid')
			await app.orderService.transition(id, 'building')
			return id
		}
		const payUpfront = async (id: string) => {
			const payment = await app.db.orders.insertPayment({
				orderId: id,
				kind: 'deposit',
				provider: 'fake',
				amountSek: 500,
				vatSek: 125,
				totalSek: 625,
				sessionId: 'fake_full',
			})
			await app.db.orders.markPaymentPaid(payment.id, {})
		}
		const jobDelivered = (id: string) =>
			vi
				.spyOn(app.db.jobs, 'list')
				.mockResolvedValue([createMockJob({ orderId: id, status: 'delivered' })])

		it('Closes a delivered full-upfront order as paid (no balance step)', async () => {
			const id = await toBuilding(500)
			await payUpfront(id)
			jobDelivered(id)

			const detail = await app.orderService.getDetail(id, user)

			expect(detail.order.status).toBe('paid')
		})

		it('Leaves a delivered full-upfront order without a paid upfront payment as delivered', async () => {
			// The admin override path (frozen → building without a payment) still invoices normally
			const id = await toBuilding(500)
			jobDelivered(id)

			const detail = await app.orderService.getDetail(id, user)

			expect(detail.order.status).toBe('delivered')
		})

		it('Keeps the deposit/balance split for orders at the threshold and above', async () => {
			const id = await toBuilding(3_000)
			await payUpfront(id)
			jobDelivered(id)

			const detail = await app.orderService.getDetail(id, user)

			expect(detail.order.status).toBe('delivered')
		})

		it('Also settles after an approval (awaiting_approval → delivered → paid)', async () => {
			const id = await toBuilding(500)
			await payUpfront(id)
			await app.db.orders.setApproveBeforeDeliver(id, true)
			jobDelivered(id)
			await expect(app.orderService.getDetail(id, user)).resolves.toMatchObject({
				order: { status: 'awaiting_approval' },
			})

			await expect(app.orderService.approve(id, user)).resolves.toMatchObject({ status: 'paid' })
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

	describe('startBuild (deposit webhook + demo approval)', () => {
		const paidOrder = async (kind: OrderKind = 'build') => {
			const order = await app.orderService.create('x', user, kind)
			for (const status of ['ready', 'frozen', 'deposit_paid'] as const) {
				await app.orderService.transition(order.id, status)
			}
			return order
		}

		it('Starts the job as the caller, marks the order building and provisions the account', async () => {
			const { id } = await paidOrder()

			await app.orderService.startBuild(id, admin)

			expect(app.jobService.start).toHaveBeenCalledWith(id, admin)
			expect(app.accountService.provisionCustomerAccount).toHaveBeenCalledWith('org-1')
			await expect(app.orderService.get(id, user)).resolves.toMatchObject({ status: 'building' })
		})

		it('Throws when the job cannot start, leaves the order paid, still provisions the account', async () => {
			const { id } = await paidOrder()
			vi.mocked(app.jobService.start).mockRejectedValueOnce(new Error('ECS down'))
			vi.mocked(app.accountService.provisionCustomerAccount).mockRejectedValueOnce(
				new Error('CreateAccount failed')
			)

			await expect(app.orderService.startBuild(id, admin)).rejects.toThrow('ECS down')

			await expect(app.orderService.get(id, user)).resolves.toMatchObject({
				status: 'deposit_paid',
			})
			expect(app.accountService.provisionCustomerAccount).toHaveBeenCalledWith('org-1')
			// The provisioning rejection is fire-and-forget: let its .catch() settle
			await new Promise(resolve => setImmediate(resolve))
		})

		it("Is org-scoped like every other read: another org's order is not found", async () => {
			const { id } = await paidOrder()
			await expect(app.orderService.startBuild(id, other)).rejects.toBeInstanceOf(EntityNotFound)
			expect(app.jobService.start).not.toHaveBeenCalled()
		})
	})

	describe('approveDemoBuild / demoQueue (voucher demo, wave 14)', () => {
		const paidDemo = async (kind: OrderKind = 'demo') => {
			const order = await app.orderService.create('demo', user, kind)
			for (const status of ['ready', 'frozen', 'deposit_paid'] as const) {
				await app.orderService.transition(order.id, status)
			}
			return order
		}

		it('Stamps the approval and starts the build like the webhook does', async () => {
			const { id } = await paidDemo()

			const approved = await app.orderService.approveDemoBuild(id, admin)

			expect(approved).toMatchObject({
				id,
				kind: 'demo',
				status: 'building',
				buildApprovedAt: expect.any(String),
			})
			expect(app.jobService.start).toHaveBeenCalledWith(id, admin)
			expect(app.accountService.provisionCustomerAccount).toHaveBeenCalledWith('org-1')
			await expect(app.db.orders.countDemoApprovalsSince(new Date(0))).resolves.toBe(1)
		})

		it('Refuses a real build and a demo that is not deposit_paid', async () => {
			const build = await paidDemo('build')
			await expect(app.orderService.approveDemoBuild(build.id, admin)).rejects.toBeInstanceOf(
				DemoNotApprovable
			)

			const frozen = await app.orderService.create('demo', user, 'demo')
			await app.orderService.transition(frozen.id, 'ready')
			await app.orderService.transition(frozen.id, 'frozen')
			await expect(app.orderService.approveDemoBuild(frozen.id, admin)).rejects.toBeInstanceOf(
				DemoNotApprovable
			)

			expect(app.jobService.start).not.toHaveBeenCalled()
			await expect(app.orderService.approveDemoBuild('missing', admin)).rejects.toBeInstanceOf(
				EntityNotFound
			)
		})

		it('Enforces the weekly cap over a rolling seven days, and `force` bypasses it', async () => {
			app.secrets.demoWeeklyCap = 2
			// Last week's approval is outside the rolling window and does not count
			const stale = await paidDemo()
			await app.db.orders.setBuildApprovedAt(stale.id, new Date(Date.now() - demoCapWindowMs - 1))
			const first = await paidDemo()
			const second = await paidDemo()
			const third = await paidDemo()
			await app.orderService.approveDemoBuild(first.id, admin)
			await app.orderService.approveDemoBuild(second.id, admin)

			// The week is full: refused with the count, nothing stamped, nothing started
			await expect(app.orderService.approveDemoBuild(third.id, admin)).rejects.toMatchObject({
				approved: 2,
				cap: 2,
			})
			await expect(app.orderService.approveDemoBuild(third.id, admin)).rejects.toBeInstanceOf(
				DemoWeeklyCapReached
			)
			expect(app.jobService.start).toHaveBeenCalledTimes(2)
			const refused = await app.orderService.get(third.id, user)
			expect(refused.status).toBe('deposit_paid')
			expect(refused.buildApprovedAt).toBeUndefined()

			// An admin may deliberately over-allocate the week
			await expect(
				app.orderService.approveDemoBuild(third.id, admin, { force: true })
			).resolves.toMatchObject({ status: 'building', buildApprovedAt: expect.any(String) })
			expect(app.jobService.start).toHaveBeenCalledTimes(3)
			await expect(app.orderService.demoQueue()).resolves.toMatchObject({
				orders: [],
				approvedThisWeek: 3,
				cap: 2,
			})
		})

		it('Restarts an approved demo whose build failed to start without a second approval', async () => {
			const { id } = await paidDemo()
			vi.mocked(app.jobService.start).mockRejectedValueOnce(new Error('ECS down'))

			await expect(app.orderService.approveDemoBuild(id, admin)).rejects.toThrow('ECS down')
			const stamped = await app.orderService.get(id, user)
			expect(stamped).toMatchObject({ status: 'deposit_paid', buildApprovedAt: expect.any(String) })

			// The retry: same approval instant, one more start, the week's count unchanged
			const started = await app.orderService.approveDemoBuild(id, admin)

			expect(started).toMatchObject({
				status: 'building',
				buildApprovedAt: stamped.buildApprovedAt,
			})
			expect(app.jobService.start).toHaveBeenCalledTimes(2)
			await expect(app.db.orders.countDemoApprovalsSince(new Date(0))).resolves.toBe(1)
		})

		it('Lists the paid, unapproved demos oldest first with the cap state', async () => {
			vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-09-02T10:00:00.000Z') })
			try {
				const older = await paidDemo()
				vi.setSystemTime(new Date('2026-09-02T11:00:00.000Z'))
				const approved = await paidDemo()
				await app.orderService.approveDemoBuild(approved.id, admin)
				vi.setSystemTime(new Date('2026-09-02T12:00:00.000Z'))
				const newer = await paidDemo()
				await paidDemo('build')
				await app.orderService.create('drafting demo', user, 'demo')

				const queue = await app.orderService.demoQueue()

				expect(queue.orders.map(order => order.id)).toEqual([older.id, newer.id])
				expect(queue).toMatchObject({ approvedThisWeek: 1, cap: 5 })
			} finally {
				vi.useRealTimers()
			}
		})
	})
})

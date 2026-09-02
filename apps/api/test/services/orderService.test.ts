import { EntityNotFound } from '#/lib/entityError.ts'
import { createMockJob, createMockJobEvent } from '#/plugins/__mocks__/db.ts'
import { createMockDeliverable } from '#/services/__mocks__/jobService.ts'
import {
	claimRateLimit,
	ClaimRateLimited,
	claimRateLimitScope,
	demoCapWindowMs,
	DemoNotApprovable,
	DemoWeeklyCapReached,
	InvalidOrderTransition,
	transitionSources,
} from '#/services/orderService.ts'
import { hashQuoteToken } from '#/services/quoteService.utils.ts'

import type { FastifyInstance } from 'fastify'
import type { BackendSession, JobEvent, OrderKind, OrderStatus } from '@mf/models'

const user: BackendSession = { userId: 'user-1', role: 'user', orgId: 'org-1' }
const other: BackendSession = { userId: 'user-2', role: 'user', orgId: 'org-2' }
const admin: BackendSession = { userId: 'admin-1', role: 'admin', orgId: 'org-admin' }

/** The final `bundle` delivery event of a job — with a live preview URL, or without one */
const bundleEvent = (jobId: string, deployUrl: string | null): JobEvent =>
	createMockJobEvent({
		id: 9,
		jobId,
		type: 'delivery',
		payload: { step: 'bundle', ok: true, deliverable: createMockDeliverable({ jobId, deployUrl }) },
	})

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
		const delivered = (id: string) => {
			vi.spyOn(app.db.jobs, 'listEvents').mockResolvedValue([bundleEvent('job-1', 'https://x')])
			return [createMockJob({ orderId: id, status: 'delivered' })]
		}

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
		const jobDelivered = (id: string, deployUrl: string | null = 'https://preview.on.aws') => {
			vi.spyOn(app.db.jobs, 'list').mockResolvedValue([
				createMockJob({ orderId: id, status: 'delivered' }),
			])
			vi.spyOn(app.db.jobs, 'listEvents').mockResolvedValue([bundleEvent('job-1', deployUrl)])
		}

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

		it('Does NOT close an unhosted delivery as paid — the customer bought a hosted app', async () => {
			const id = await toBuilding(500)
			await payUpfront(id)
			jobDelivered(id, null)

			const detail = await app.orderService.getDetail(id, user)

			expect(detail.order.status).toBe('delivered')
			expect(detail.hosting.status).toBe('unhosted')
			// Still not on a later read while the preview is missing
			await expect(app.orderService.getDetail(id, user)).resolves.toMatchObject({
				order: { status: 'delivered' },
			})
		})

		it('Settles a delivered order on a later read once a redelivery brought the preview up', async () => {
			const id = await toBuilding(500)
			await payUpfront(id)
			jobDelivered(id, null)
			await expect(app.orderService.getDetail(id, user)).resolves.toMatchObject({
				order: { status: 'delivered' },
			})

			// A `redeliver` job of the same order delivered with a URL: it is the newest delivered job
			vi.spyOn(app.db.jobs, 'list').mockResolvedValue([
				createMockJob({ id: 'job-2', orderId: id, status: 'delivered', mode: 'redeliver' }),
				createMockJob({ id: 'job-1', orderId: id, status: 'delivered', reason: 'deploy: skipped' }),
			])
			vi.spyOn(app.db.jobs, 'listEvents').mockResolvedValue([bundleEvent('job-2', 'https://x')])

			const detail = await app.orderService.getDetail(id, user)

			expect(app.db.jobs.listEvents).toHaveBeenLastCalledWith('job-2')
			expect(detail.hosting).toEqual({ status: 'live', deployUrl: 'https://x', reason: null })
			expect(detail.order.status).toBe('paid')
		})

		it('Approval of an unhosted delivery leaves the order delivered, not paid', async () => {
			const id = await toBuilding(500)
			await payUpfront(id)
			await app.db.orders.setApproveBeforeDeliver(id, true)
			jobDelivered(id, null)
			await app.orderService.getDetail(id, user)

			await expect(app.orderService.approve(id, user)).resolves.toMatchObject({
				status: 'delivered',
			})
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
				mode: undefined,
				sourceJobId: undefined,
				reason: undefined,
				tokensUsed: 42,
				budget: job.budget,
				startedAt: undefined,
				finishedAt: undefined,
				createdAt: job.createdAt,
			})
			expect(detail.latestJob).not.toHaveProperty('spec')
			expect(detail.jobs).toEqual([detail.latestJob])
			expect(detail.hosting).toEqual({ status: 'none', deployUrl: null, reason: null })
			expect(detail.payments).toHaveLength(1)
		})

		it('Lists every job newest first with mode, source and reason', async () => {
			const { id } = await app.orderService.create('x', user)
			vi.spyOn(app.db.jobs, 'list').mockResolvedValue([
				createMockJob({
					id: 'job-2',
					orderId: id,
					status: 'building',
					mode: 'redeliver',
					sourceJobId: 'job-1',
				}),
				createMockJob({ id: 'job-1', orderId: id, status: 'delivered', reason: 'deploy: skipped' }),
			])
			vi.spyOn(app.db.jobs, 'listEvents').mockResolvedValue([])

			const detail = await app.orderService.getDetail(id, user)

			expect(detail.jobs.map(job => [job.id, job.mode, job.sourceJobId, job.reason])).toEqual([
				['job-2', 'redeliver', 'job-1', undefined],
				['job-1', undefined, undefined, 'deploy: skipped'],
			])
			expect(detail.latestJob?.id).toBe('job-2')
		})

		describe('hosting (what the customer actually got, F7)', () => {
			it('none: no job has delivered yet', async () => {
				const { id } = await app.orderService.create('x', user)
				vi.spyOn(app.db.jobs, 'list').mockResolvedValue([
					createMockJob({ orderId: id, status: 'failed', reason: 'boom' }),
				])

				const detail = await app.orderService.getDetail(id, user)

				expect(detail.hosting).toEqual({ status: 'none', deployUrl: null, reason: null })
				expect(app.db.jobs.listEvents).not.toHaveBeenCalled()
			})

			it('live: the latest delivered job carries a preview URL', async () => {
				const { id } = await app.orderService.create('x', user)
				vi.spyOn(app.db.jobs, 'list').mockResolvedValue([
					createMockJob({ id: 'job-1', orderId: id, status: 'delivered' }),
				])
				vi.spyOn(app.db.jobs, 'listEvents').mockResolvedValue([
					bundleEvent('job-1', 'https://mf-x.on.aws'),
				])

				const detail = await app.orderService.getDetail(id, user)

				expect(detail.hosting).toEqual({
					status: 'live',
					deployUrl: 'https://mf-x.on.aws',
					reason: null,
				})
			})

			it('unhosted: delivered without a URL, with the job’s forwarded reason', async () => {
				const { id } = await app.orderService.create('x', user)
				vi.spyOn(app.db.jobs, 'list').mockResolvedValue([
					createMockJob({
						id: 'job-1',
						orderId: id,
						status: 'delivered',
						reason: 'acceptance: blank page',
					}),
				])
				vi.spyOn(app.db.jobs, 'listEvents').mockResolvedValue([bundleEvent('job-1', null)])

				const detail = await app.orderService.getDetail(id, user)

				expect(detail.hosting).toEqual({
					status: 'unhosted',
					deployUrl: null,
					reason: 'acceptance: blank page',
				})
			})

			it('unhosted: falls back to the failed deploy/acceptance step for rows without a reason', async () => {
				// Jobs delivered before the harness forwarded the delivery reason
				const { id } = await app.orderService.create('x', user)
				vi.spyOn(app.db.jobs, 'list').mockResolvedValue([
					createMockJob({ id: 'job-1', orderId: id, status: 'delivered' }),
				])
				vi.spyOn(app.db.jobs, 'listEvents').mockResolvedValue([
					createMockJobEvent({
						id: 7,
						type: 'delivery',
						payload: { step: 'deploy', ok: true, url: 'https://mf-x.on.aws' },
					}),
					createMockJobEvent({
						id: 8,
						type: 'delivery',
						payload: {
							step: 'acceptance',
							ok: false,
							reason: 'blank page',
							url: 'https://mf-x.on.aws',
						},
					}),
					bundleEvent('job-1', null),
				])

				const detail = await app.orderService.getDetail(id, user)

				expect(detail.hosting).toEqual({
					status: 'unhosted',
					deployUrl: null,
					reason: 'blank page',
				})
			})

			it('unhosted with no reason at all when nothing recorded why', async () => {
				const { id } = await app.orderService.create('x', user)
				vi.spyOn(app.db.jobs, 'list').mockResolvedValue([
					createMockJob({ id: 'job-1', orderId: id, status: 'delivered' }),
				])
				vi.spyOn(app.db.jobs, 'listEvents').mockResolvedValue([])

				const detail = await app.orderService.getDetail(id, user)

				expect(detail.hosting).toEqual({ status: 'unhosted', deployUrl: null, reason: null })
			})

			it('judges the newest DELIVERED job, not a newer failed retry', async () => {
				const { id } = await app.orderService.create('x', user)
				vi.spyOn(app.db.jobs, 'list').mockResolvedValue([
					createMockJob({ id: 'job-3', orderId: id, status: 'failed', mode: 'redeliver' }),
					createMockJob({ id: 'job-2', orderId: id, status: 'delivered' }),
					createMockJob({ id: 'job-1', orderId: id, status: 'delivered' }),
				])
				vi.spyOn(app.db.jobs, 'listEvents').mockResolvedValue([bundleEvent('job-2', 'https://x')])

				const detail = await app.orderService.getDetail(id, user)

				expect(app.db.jobs.listEvents).toHaveBeenCalledWith('job-2')
				expect(detail.hosting.status).toBe('live')
			})
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

		it('Holds the cap under concurrent approvals: count and stamp are one repository step', async () => {
			app.secrets.demoWeeklyCap = 1
			const first = await paidDemo()
			const second = await paidDemo()

			// Both approvals read the same "0 of 1" week; only one may stamp and start
			const results = await Promise.allSettled([
				app.orderService.approveDemoBuild(first.id, admin),
				app.orderService.approveDemoBuild(second.id, admin),
			])

			expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
			expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(DemoWeeklyCapReached)
			expect(app.jobService.start).toHaveBeenCalledTimes(1)
			await expect(app.db.orders.countDemoApprovalsSince(new Date(0))).resolves.toBe(1)
		})

		it('Starts the build for the loser of a concurrent approval of the SAME demo', async () => {
			const { id } = await paidDemo()
			// The other admin's approval landed between this call's read and its stamp
			vi.spyOn(app.db.orders, 'stampDemoApproval').mockImplementationOnce(
				async (orderId, approvedAt, window) => {
					await app.db.orders.setBuildApprovedAt(orderId, new Date(approvedAt.getTime() - 1))
					return { order: undefined, approved: window.cap ?? 0 }
				}
			)

			await expect(app.orderService.approveDemoBuild(id, admin)).resolves.toMatchObject({
				status: 'building',
			})
			expect(app.jobService.start).toHaveBeenCalledTimes(1)
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
				// The queue is its own query: the oldest waiting demo stays listed once the order
				// table has outgrown the newest-200 window `list` reads
				for (let i = 0; i < 205; i++) {
					vi.setSystemTime(new Date(Date.UTC(2026, 8, 2, 13, 0, i)))
					await app.orderService.create(`filler ${i}`, user)
				}
				expect((await app.orderService.list(admin)).map(order => order.id)).not.toContain(older.id)
				expect((await app.orderService.demoQueue()).orders.map(order => order.id)).toEqual([
					older.id,
					newer.id,
				])
			} finally {
				vi.useRealTimers()
			}
		})
	})

	// MARK: Anonymous quotes (wave 14, F1)

	describe('claim', () => {
		const token = 'c'.repeat(64)

		/** An anonymous quote as `quoteService.create` stores it (org `anon:…`, hashed token) */
		const seedQuote = async (id = 'quote-1') =>
			app.db.orders.insert({
				id,
				orgId: `anon:${'0'.repeat(32)}`,
				name: 'Offert',
				quoteTokenHash: hashQuoteToken(token),
			})

		it('Moves the quote to the session org and user, and the token dies with it', async () => {
			const quote = await seedQuote()

			const claimed = await app.orderService.claim(quote.id, token, user)

			expect(claimed).toMatchObject({ id: quote.id, orgId: 'org-1', createdBy: 'user-1' })
			// Now an ordinary order: visible, listable, spec draft under the org
			await expect(app.orderService.get(quote.id, user)).resolves.toMatchObject({ orgId: 'org-1' })
			expect((await app.orderService.list(user)).map(order => order.id)).toEqual([quote.id])
			await expect(app.db.orders.get(quote.id)).resolves.toMatchObject({ orgId: 'org-1' })
			await expect(
				app.db.orders.getOrderByQuoteToken(quote.id, hashQuoteToken(token))
			).resolves.toBeUndefined()
		})

		it('Refuses a second claim, a wrong token and an unknown order alike (not found)', async () => {
			const quote = await seedQuote()
			await app.orderService.claim(quote.id, token, user)

			await expect(app.orderService.claim(quote.id, token, other)).rejects.toBeInstanceOf(
				EntityNotFound
			)
			await expect(app.orderService.get(quote.id, other)).rejects.toBeInstanceOf(EntityNotFound)
			await expect(
				app.orderService.claim((await seedQuote('quote-2')).id, 'd'.repeat(64), user)
			).rejects.toBeInstanceOf(EntityNotFound)
			await expect(app.orderService.claim('missing', token, user)).rejects.toBeInstanceOf(
				EntityNotFound
			)
		})

		it('Cannot claim an ordinary order with any token (no hash to match)', async () => {
			const mine = await app.orderService.create('Mine', user)

			await expect(app.orderService.claim(mine.id, token, other)).rejects.toBeInstanceOf(
				EntityNotFound
			)
			await expect(app.orderService.get(mine.id, user)).resolves.toMatchObject({ orgId: 'org-1' })
		})

		it('Rate limits claim attempts per session, counting the failed ones', async () => {
			const quote = await seedQuote()
			for (let i = 0; i < claimRateLimit.max; i++) {
				await expect(app.orderService.claim(quote.id, 'd'.repeat(64), user)).rejects.toBeInstanceOf(
					EntityNotFound
				)
			}

			await expect(app.orderService.claim(quote.id, token, user)).rejects.toBeInstanceOf(
				ClaimRateLimited
			)
			// Another session's window is untouched; the quote is still claimable
			await expect(app.orderService.claim(quote.id, token, other)).resolves.toMatchObject({
				orgId: 'org-2',
			})
			const since = new Date(Date.now() - 60_000)
			await expect(app.db.rateLimits.count(claimRateLimitScope, 'user-1', since)).resolves.toBe(
				claimRateLimit.max + 1
			)
		})
	})
})

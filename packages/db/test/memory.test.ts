import { createMemoryRepositories } from '#/memory.ts'

import type { Spec } from '@mf/models'
import type { Repositories } from '#/repositories.ts'

const spec: Spec = {
	goal: 'g',
	users: [],
	features: [],
	nonGoals: [],
	stackConstraints: [],
	sizeClass: 'S',
}
const budget = { maxTokens: 1000, maxWorkers: 1, maxDurationMinutes: 10 }

describe('memory repositories', () => {
	let repos: Repositories

	beforeEach(() => {
		repos = createMemoryRepositories()
	})

	describe('jobs', () => {
		it('Finds a job by its report token hash and keeps the hash off the model', async () => {
			const job = await repos.jobs.insert({
				orderId: 'o1',
				orgId: 'org',
				spec,
				budget,
				reportTokenHash: 'hash-1',
			})

			await expect(repos.jobs.getByReportToken('hash-1')).resolves.toEqual(job)
			await expect(repos.jobs.getByReportToken('hash-2')).resolves.toBeUndefined()
			expect(job).not.toHaveProperty('reportTokenHash')
		})

		it('Persists gates and gate waivers on update', async () => {
			const job = await repos.jobs.insert({ orderId: 'o1', orgId: 'org', spec, budget })
			const gate = {
				name: 'verify' as const,
				ok: true,
				startedAt: '2026-08-26T10:00:00.000Z',
				durationMs: 1,
				tokens: 0,
				summary: 'ok',
			}

			const updated = await repos.jobs.update(job.id, { gates: [gate], gateWaivers: ['a.ts:1'] })

			expect(updated).toMatchObject({ gates: [gate], gateWaivers: ['a.ts:1'] })
		})

		it('Allows one active job per order and mirrors the unique violation code', async () => {
			const job = await repos.jobs.insert({ orderId: 'o1', orgId: 'org', spec, budget })
			await expect(
				repos.jobs.insert({ orderId: 'o1', orgId: 'org', spec, budget })
			).rejects.toMatchObject({ code: '23505' })

			await repos.jobs.update(job.id, { status: 'failed', finishedAt: new Date() })
			await expect(
				repos.jobs.insert({ orderId: 'o1', orgId: 'org', spec, budget })
			).resolves.toMatchObject({ orderId: 'o1', status: 'queued' })
		})

		it('Keeps killed terminal and numbers events per repository', async () => {
			const job = await repos.jobs.insert({ orderId: 'o1', orgId: 'org', spec, budget })
			await repos.jobs.update(job.id, { status: 'killed' })
			await expect(repos.jobs.update(job.id, { status: 'building' })).resolves.toBeUndefined()
			await expect(repos.jobs.update(job.id, { tokensUsed: 5 })).resolves.toMatchObject({
				status: 'killed',
				tokensUsed: 5,
			})

			await repos.jobs.appendEvent(job.id, { type: 'started', payload: {} })
			await repos.jobs.appendEvent(job.id, { type: 'failed', payload: { reason: 'x' } })
			const events = await repos.jobs.listEvents(job.id, 1)
			expect(events.map(event => [event.id, event.type])).toEqual([[2, 'failed']])
		})

		it('Stores a numbered event once and counts events by type', async () => {
			const job = await repos.jobs.insert({ orderId: 'o1', orgId: 'org', spec, budget })
			const notify = { type: 'notify' as const, payload: { to: 'admins' } }

			const first = await repos.jobs.appendEventOnce(job.id, 1, notify)
			const replay = await repos.jobs.appendEventOnce(job.id, 1, notify)
			await repos.jobs.appendEventOnce(job.id, 2, { type: 'log', payload: {} })

			expect(first).toMatchObject({ duplicate: false, event: { id: 1, type: 'notify' } })
			expect(replay).toEqual({ ...first, duplicate: true })
			expect(await repos.jobs.listEvents(job.id)).toHaveLength(2)
			expect(await repos.jobs.countEvents(job.id, 'notify')).toBe(1)
			expect(await repos.jobs.countEvents(job.id, 'gate')).toBe(0)
		})

		it('Rotates and revokes the report token hash through update', async () => {
			const job = await repos.jobs.insert({
				orderId: 'o1',
				orgId: 'org',
				spec,
				budget,
				reportTokenHash: 'boot',
			})

			await repos.jobs.update(job.id, { reportTokenHash: 'fresh' })
			expect(await repos.jobs.getByReportToken('boot')).toBeUndefined()
			expect((await repos.jobs.getByReportToken('fresh'))?.id).toBe(job.id)

			await repos.jobs.update(job.id, { status: 'delivered', reportTokenHash: null })
			expect(await repos.jobs.getByReportToken('fresh')).toBeUndefined()
		})

		it('Filters lists by order and org and returns copies', async () => {
			await repos.jobs.insert({ orderId: 'o1', orgId: 'a', spec, budget })
			await repos.jobs.insert({ orderId: 'o2', orgId: 'b', spec, budget })
			expect(await repos.jobs.list({ orgId: 'a' })).toHaveLength(1)
			expect(await repos.jobs.list({ orderId: 'o2' })).toHaveLength(1)
			expect(await repos.jobs.list()).toHaveLength(2)

			const [first] = await repos.jobs.list({ orgId: 'a' })
			first!.spec.goal = 'mutated'
			expect((await repos.jobs.get(first!.id))?.spec.goal).toBe('g')
		})
	})

	describe('orders', () => {
		it('Upserts by order id and scopes lists by org', async () => {
			const draft = {
				orderId: 'demo',
				orgId: 'a',
				status: 'drafting' as const,
				spec: {},
				messages: [],
				openQuestions: [],
			}
			await repos.orders.upsert(draft, 'user-1')
			await repos.orders.upsert({ ...draft, status: 'ready', priceSek: 15_000 })
			await repos.orders.upsert({ ...draft, orderId: 'other', orgId: 'b' })

			await expect(repos.orders.get('demo')).resolves.toMatchObject({
				status: 'ready',
				priceSek: 15_000,
			})
			await expect(repos.orders.get('missing')).resolves.toBeUndefined()
			expect((await repos.orders.list({ orgId: 'a' })).map(d => d.orderId)).toEqual(['demo'])
			expect(await repos.orders.list()).toHaveLength(2)
		})

		it('Lists newest first, capped at 200, like the SQL repository', async () => {
			vi.useFakeTimers({ toFake: ['Date'] })
			const draft = {
				orgId: 'a',
				status: 'drafting' as const,
				spec: {},
				messages: [],
				openQuestions: [],
			}
			for (let index = 0; index < 205; index++) {
				vi.setSystemTime(new Date(2026, 0, 1, 0, 0, index))
				await repos.orders.upsert({ ...draft, orderId: `order-${index}` })
			}
			// An update keeps the original creation time
			vi.setSystemTime(new Date(2027, 0, 1))
			await repos.orders.upsert({ ...draft, orderId: 'order-0', status: 'ready' })
			vi.useRealTimers()

			const listed = await repos.orders.list()
			expect(listed).toHaveLength(200)
			expect(listed[0]?.orderId).toBe('order-204')
			expect(listed.at(-1)?.orderId).toBe('order-5')
		})

		it('updateUnlessFrozen writes only while the stored draft is not frozen', async () => {
			const draft = {
				orderId: 'demo',
				orgId: 'a',
				status: 'drafting' as const,
				spec: {},
				messages: [],
				openQuestions: [],
			}
			await expect(repos.orders.updateUnlessFrozen(draft)).resolves.toBeUndefined()

			await repos.orders.upsert(draft)
			await expect(
				repos.orders.updateUnlessFrozen({ ...draft, status: 'ready' })
			).resolves.toMatchObject({ status: 'ready' })

			await repos.orders.upsert({ ...draft, status: 'frozen', frozenAt: new Date().toISOString() })
			await expect(
				repos.orders.updateUnlessFrozen({ ...draft, status: 'ready' })
			).resolves.toBeUndefined()
			await expect(repos.orders.get('demo')).resolves.toMatchObject({ status: 'frozen' })
		})

		it('Creates an order record whose draft is empty and derives the spec status from it', async () => {
			const order = await repos.orders.insert({
				id: 'o1',
				orgId: 'a',
				name: 'Gym booking',
				customerGithubLogin: 'anna',
			})
			expect(order).toMatchObject({
				id: 'o1',
				status: 'drafting',
				name: 'Gym booking',
				customerGithubLogin: 'anna',
			})
			await expect(repos.orders.get('o1')).resolves.toMatchObject({
				orderId: 'o1',
				orgId: 'a',
				status: 'drafting',
				spec: {},
			})

			const draft = (await repos.orders.get('o1'))!
			await repos.orders.upsert({ ...draft, status: 'frozen', priceSek: 15_000 })
			await expect(repos.orders.getOrder('o1')).resolves.toMatchObject({
				status: 'frozen',
				priceSek: 15_000,
				name: 'Gym booking',
			})
		})

		it('Transitions with compare-and-set and keeps the draft frozen past the spec phase', async () => {
			await repos.orders.insert({ id: 'o1', orgId: 'a', name: 'x' })
			await expect(
				repos.orders.transition('o1', ['frozen'], 'deposit_paid')
			).resolves.toBeUndefined()
			await repos.orders.transition('o1', ['drafting', 'ready'], 'frozen')
			await expect(
				repos.orders.transition('o1', ['frozen'], 'deposit_paid')
			).resolves.toMatchObject({ status: 'deposit_paid' })

			// The spec engine sees a frozen draft, cannot write, and an upsert of "frozen" does not regress
			await expect(repos.orders.get('o1')).resolves.toMatchObject({ status: 'frozen' })
			const draft = (await repos.orders.get('o1'))!
			await expect(repos.orders.updateUnlessFrozen(draft)).resolves.toBeUndefined()
			await repos.orders.upsert(draft)
			await expect(repos.orders.getOrder('o1')).resolves.toMatchObject({ status: 'deposit_paid' })
			expect((await repos.orders.listOrders({ orgId: 'a' })).map(o => o.id)).toEqual(['o1'])
		})

		it('Stores payments per session, marks paid once and dedupes webhook events', async () => {
			await repos.orders.insert({ id: 'o1', orgId: 'a', name: 'x' })
			const payment = await repos.orders.insertPayment({
				orderId: 'o1',
				kind: 'deposit',
				provider: 'fake',
				amountSek: 7_500,
				vatSek: 1_875,
				totalSek: 9_375,
				sessionId: 'fake_1',
			})
			expect(payment).toMatchObject({ id: expect.any(String), status: 'pending' })
			await expect(
				repos.orders.insertPayment({ ...payment, sessionId: 'fake_1' })
			).rejects.toMatchObject({ code: '23505' })

			await expect(repos.orders.findPaymentBySession('fake_1')).resolves.toMatchObject({
				id: payment.id,
			})
			await expect(
				repos.orders.markPaymentPaid(payment.id, { eventId: 'evt_1', receiptUrl: 'r' })
			).resolves.toMatchObject({ status: 'paid', eventId: 'evt_1', paidAt: expect.any(String) })
			await expect(
				repos.orders.markPaymentPaid(payment.id, { eventId: 'evt_2' })
			).resolves.toBeUndefined()
			expect(await repos.orders.listPayments('o1')).toHaveLength(1)

			await expect(repos.orders.recordPaymentEvent('evt_1', 't')).resolves.toBe(true)
			await expect(repos.orders.recordPaymentEvent('evt_1', 't')).resolves.toBe(false)
		})
	})

	describe('users', () => {
		it('Creates orgs and users with generated ids and finds users by email', async () => {
			const org = await repos.users.insertOrg({ name: 'acme.se' })
			const user = await repos.users.insert({ email: 'anna@acme.se', role: 'user', orgId: org.id })

			expect(user).toMatchObject({ id: expect.any(String), orgId: org.id, role: 'user' })
			await expect(repos.users.get(user.id)).resolves.toEqual(user)
			await expect(repos.users.findByEmail('anna@acme.se')).resolves.toEqual(user)
			await expect(repos.users.findByEmail('ANNA@acme.se')).resolves.toBeUndefined()
			await expect(repos.users.getOrg(org.id)).resolves.toEqual(org)
			await expect(repos.users.listOrgs()).resolves.toEqual([org])
		})

		it('Enforces one user per email like users_email_key, also for insertWithOrg', async () => {
			const user = await repos.users.insertWithOrg(
				{ email: 'anna@acme.se', role: 'user' },
				{ name: 'acme.se' }
			)
			expect(user.orgId).toBeDefined()
			await expect(repos.users.getOrg(user.orgId)).resolves.toMatchObject({ name: 'acme.se' })

			await expect(
				repos.users.insert({ email: 'anna@acme.se', role: 'user', orgId: user.orgId })
			).rejects.toMatchObject({ code: '23505' })
			await expect(
				repos.users.insertWithOrg({ email: 'anna@acme.se', role: 'user' }, { name: 'dup' })
			).rejects.toMatchObject({ code: '23505' })
			// No orphan org from the rejected attempt
			await expect(repos.users.listOrgs()).resolves.toHaveLength(1)
		})

		it('Links a GitHub identity, finds users by GitHub id and keeps one user per account', async () => {
			const anna = await repos.users.insertWithOrg(
				{ email: 'anna@acme.se', role: 'user' },
				{ name: 'acme.se' }
			)
			const bob = await repos.users.insert({
				email: 'bob@acme.se',
				role: 'user',
				orgId: anna.orgId,
				githubId: '7',
				githubLogin: 'bob',
			})

			const linked = await repos.users.linkGithub(anna.id, {
				githubId: '42',
				githubLogin: 'anna',
				name: 'Anna',
			})

			expect(linked).toMatchObject({
				id: anna.id,
				githubId: '42',
				githubLogin: 'anna',
				name: 'Anna',
			})
			await expect(repos.users.findByGithubId('42')).resolves.toEqual(linked)
			await expect(repos.users.findByGithubId('7')).resolves.toEqual(bob)
			await expect(repos.users.findByGithubId('1')).resolves.toBeUndefined()
			await expect(
				repos.users.linkGithub('missing', { githubId: '1', githubLogin: 'x' })
			).resolves.toBeUndefined()
			// Rename on GitHub: same id, new login; an existing name is kept
			await expect(
				repos.users.linkGithub(anna.id, { githubId: '42', githubLogin: 'anna2', name: 'Other' })
			).resolves.toMatchObject({ githubLogin: 'anna2', name: 'Anna' })
			await expect(
				repos.users.linkGithub(bob.id, { githubId: '42', githubLogin: 'anna' })
			).rejects.toMatchObject({ code: '23505' })
		})
	})

	describe('auth', () => {
		it('Magic links are single use and counted per email since an instant', async () => {
			const expiresAt = new Date(Date.now() + 60_000)
			await repos.auth.insertMagicLink({ tokenHash: 'h1', email: 'a@x.se', expiresAt })
			await repos.auth.insertMagicLink({ tokenHash: 'h2', email: 'a@x.se', expiresAt })
			await repos.auth.insertMagicLink({ tokenHash: 'h3', email: 'b@x.se', expiresAt })

			await expect(
				repos.auth.countMagicLinksSince('a@x.se', new Date(Date.now() - 1000))
			).resolves.toBe(2)
			await expect(
				repos.auth.countMagicLinksSince('a@x.se', new Date(Date.now() + 1000))
			).resolves.toBe(0)

			await expect(repos.auth.consumeMagicLink('h1')).resolves.toMatchObject({
				email: 'a@x.se',
				usedAt: expect.any(String),
			})
			await expect(repos.auth.consumeMagicLink('h1')).resolves.toBeUndefined()
			await expect(repos.auth.consumeMagicLink('nope')).resolves.toBeUndefined()
			await expect(repos.auth.getMagicLink('h1')).resolves.toMatchObject({
				usedAt: expect.any(String),
			})
		})

		it('Refresh tokens are consumed once and revocation is idempotent', async () => {
			const expiresAt = new Date(Date.now() + 60_000)
			await repos.auth.insertRefreshToken({ tokenHash: 'r1', userId: 'u1', expiresAt })
			await repos.auth.insertRefreshToken({ tokenHash: 'r2', userId: 'u1', expiresAt })

			await expect(repos.auth.consumeRefreshToken('r1')).resolves.toMatchObject({
				userId: 'u1',
				revokedAt: expect.any(String),
			})
			await expect(repos.auth.consumeRefreshToken('r1')).resolves.toBeUndefined()

			await repos.auth.revokeRefreshToken('r2')
			await repos.auth.revokeRefreshToken('r2')
			await repos.auth.revokeRefreshToken('unknown')
			await expect(repos.auth.consumeRefreshToken('r2')).resolves.toBeUndefined()
		})

		it('Prunes expired links and expired or long-revoked tokens', async () => {
			const day = 24 * 60 * 60 * 1000
			const past = (days: number) => new Date(Date.now() - days * day)
			const future = new Date(Date.now() + day)
			await repos.auth.insertMagicLink({ tokenHash: 'old', email: 'a@x.se', expiresAt: past(8) })
			await repos.auth.insertMagicLink({ tokenHash: 'recent', email: 'a@x.se', expiresAt: past(1) })
			await repos.auth.insertMagicLink({ tokenHash: 'live', email: 'a@x.se', expiresAt: future })
			await repos.auth.insertRefreshToken({ tokenHash: 'expired', userId: 'u', expiresAt: past(1) })
			await repos.auth.insertRefreshToken({ tokenHash: 'revoked', userId: 'u', expiresAt: future })
			await repos.auth.insertRefreshToken({ tokenHash: 'live', userId: 'u', expiresAt: future })
			await repos.auth.revokeRefreshToken('revoked')

			await repos.auth.prune()

			await expect(repos.auth.getMagicLink('old')).resolves.toBeUndefined()
			await expect(repos.auth.getMagicLink('recent')).resolves.toBeDefined()
			await expect(repos.auth.getMagicLink('live')).resolves.toBeDefined()
			await expect(repos.auth.consumeRefreshToken('expired')).resolves.toBeUndefined()
			await expect(repos.auth.consumeRefreshToken('live')).resolves.toBeDefined()
			// Revoked just now: kept for a week, so still known (and still revoked)
			await expect(repos.auth.consumeRefreshToken('revoked')).resolves.toBeUndefined()
			await expect(repos.auth.countMagicLinksSince('a@x.se', past(30))).resolves.toBe(2)
		})
	})
})

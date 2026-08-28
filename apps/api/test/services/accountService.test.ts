import { EntityInvalid, EntityNotFound } from '#/lib/entityError.ts'

import type { FastifyInstance } from 'fastify'

describe('Account Service', () => {
	let app: FastifyInstance

	beforeEach(async () => {
		// Real accountService against the in-memory db; the @mf/org seam (`app.org`) stays mocked.
		app = await createTestApp({ skipMock: '#/services/accountService.ts' })
	})

	const seedOrg = async (name = 'Acme AB') => {
		const org = await app.db.users.insertOrg({ name })
		return org
	}

	const seedDeliveredOrder = async (customerSlug = 'acme-gym-11111111') => {
		const org = await seedOrg()
		const order = await app.db.orders.insert({ id: 'order-1', orgId: org.id, name: 'Acme gym' })
		await app.db.orders.setCustomerSlug(order.id, customerSlug)
		return { org, order }
	}

	// MARK: provisionCustomerAccount

	describe('provisionCustomerAccount', () => {
		it('Is a no-op while the flag is off, vending nothing', async () => {
			const org = await seedOrg()
			app.secrets.provisionAccounts = false

			const result = await app.accountService.provisionCustomerAccount(org.id)

			expect(result.skipped).toBe(true)
			expect(result.reason).toMatch(/PROVISION_CUSTOMER_ACCOUNTS/)
			expect(app.org.vend).not.toHaveBeenCalled()
			expect((await app.db.users.getOrg(org.id))?.awsAccountId).toBeUndefined()
		})

		it('Vends the account and records it on the org when the flag is on', async () => {
			const org = await seedOrg('Acme AB')
			app.secrets.provisionAccounts = true

			const result = await app.accountService.provisionCustomerAccount(org.id)

			expect(result.skipped).toBe(false)
			expect(result.accountId).toBe('123456789012')
			// The slug is derived from the org name (a valid @mf/org SlugSchema value)
			expect(app.org.vend).toHaveBeenCalledWith('acme-ab')
			const stored = await app.db.users.getOrg(org.id)
			expect(stored?.awsAccountId).toBe('123456789012')
			expect(stored?.awsAccountSlug).toBe('acme-ab')
		})

		it('Is idempotent once an account is recorded (no second vend)', async () => {
			const org = await seedOrg()
			app.secrets.provisionAccounts = true
			await app.accountService.provisionCustomerAccount(org.id)
			vi.mocked(app.org.vend).mockClear()

			const again = await app.accountService.provisionCustomerAccount(org.id)

			expect(again.skipped).toBe(true)
			expect(again.reason).toMatch(/already recorded/)
			expect(app.org.vend).not.toHaveBeenCalled()
		})

		it('Throws EntityNotFound for an unknown org', async () => {
			await expect(
				app.accountService.provisionCustomerAccount('11111111-1111-1111-1111-111111111111')
			).rejects.toThrow(EntityNotFound)
		})
	})

	// MARK: runLifecycleAction

	describe('runLifecycleAction', () => {
		it('Previews (dry-run) by default without changing state or tearing down', async () => {
			const { order } = await seedDeliveredOrder()

			const result = await app.accountService.runLifecycleAction(order.id, 'suspend')

			expect(result.dryRun).toBe(true)
			expect(result.applied).toBe(false)
			expect(result.deprovision?.dryRun).toBe(true)
			expect(app.org.deprovision).toHaveBeenCalledWith(
				{ customerSlug: 'acme-gym-11111111', label: 'Acme gym' },
				'suspend',
				{ dryRun: true }
			)
			expect((await app.db.orders.getOrder(order.id))?.lifecycle).toBe('active')
		})

		it('Suspends, resumes and tears down on confirm, writing the lifecycle each time', async () => {
			const { order } = await seedDeliveredOrder()

			const suspended = await app.accountService.runLifecycleAction(order.id, 'suspend', {
				confirm: true,
			})
			expect(suspended.applied).toBe(true)
			expect(suspended.to).toBe('suspended')
			expect(app.org.deprovision).toHaveBeenLastCalledWith(expect.anything(), 'suspend', {
				dryRun: false,
			})
			expect((await app.db.orders.getOrder(order.id))?.lifecycle).toBe('suspended')

			const resumed = await app.accountService.runLifecycleAction(order.id, 'resume', {
				confirm: true,
			})
			expect(resumed.to).toBe('active')
			expect((await app.db.orders.getOrder(order.id))?.lifecycle).toBe('active')

			const torn = await app.accountService.runLifecycleAction(order.id, 'teardown', {
				confirm: true,
			})
			expect(torn.to).toBe('torn_down')
			expect((await app.db.orders.getOrder(order.id))?.lifecycle).toBe('torn_down')
		})

		it('Refuses a transition the state machine disallows (resume a torn-down order)', async () => {
			const { order } = await seedDeliveredOrder()
			await app.accountService.runLifecycleAction(order.id, 'teardown', { confirm: true })

			await expect(
				app.accountService.runLifecycleAction(order.id, 'resume', { confirm: true })
			).rejects.toThrow(EntityInvalid)
			await expect(
				app.accountService.runLifecycleAction(order.id, 'suspend', { confirm: true })
			).rejects.toThrow(EntityInvalid)
		})

		it('Skips deprovision for an order that never delivered (no customer slug)', async () => {
			const org = await seedOrg()
			const order = await app.db.orders.insert({ id: 'order-2', orgId: org.id, name: 'Undelivered' })

			const result = await app.accountService.runLifecycleAction(order.id, 'suspend', {
				confirm: true,
			})

			expect(result.deprovision).toBeUndefined()
			expect(app.org.deprovision).not.toHaveBeenCalled()
			// The DB lifecycle still tracks the state so an operator can see it
			expect((await app.db.orders.getOrder(order.id))?.lifecycle).toBe('suspended')
		})

		it('Throws EntityNotFound for an unknown order', async () => {
			await expect(
				app.accountService.runLifecycleAction('order-nope', 'suspend')
			).rejects.toThrow(EntityNotFound)
		})
	})
})

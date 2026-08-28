import { EntityInvalid, EntityNotFound } from '#/lib/entityError.ts'

import type { FastifyInstance } from 'fastify'
import type { DeployedServiceConfig } from '@mf/models'

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
			const order = await app.db.orders.insert({
				id: 'order-2',
				orgId: org.id,
				name: 'Undelivered',
			})

			const result = await app.accountService.runLifecycleAction(order.id, 'suspend', {
				confirm: true,
			})

			expect(result.deprovision).toBeUndefined()
			expect(app.org.deprovision).not.toHaveBeenCalled()
			// The DB lifecycle still tracks the state so an operator can see it
			expect((await app.db.orders.getOrder(order.id))?.lifecycle).toBe('suspended')
		})

		it('Does NOT advance the lifecycle when the deprovision reports resource failures', async () => {
			const { order } = await seedDeliveredOrder()
			// Teardown runs from suspended → torn_down, so suspend first.
			await app.accountService.runLifecycleAction(order.id, 'suspend', { confirm: true })

			// @mf/org NEVER throws on a per-resource action failure: it records outcome:failed, tallies it
			// in summary.failed, and returns normally. The service must inspect the tally, not just catch.
			vi.mocked(app.org.deprovision).mockResolvedValueOnce({
				mode: 'teardown',
				dryRun: false,
				customerSlug: 'acme-gym-11111111',
				discovered: 1,
				fenced: 1,
				skippedByFence: 0,
				entries: [],
				summary: {
					planned: 0,
					suspended: 0,
					resumed: 0,
					deleted: 0,
					skipped: 0,
					'already-gone': 0,
					failed: 1,
				},
			})

			const result = await app.accountService.runLifecycleAction(order.id, 'teardown', {
				confirm: true,
			})

			expect(result.applied).toBe(false)
			expect(result.deprovision?.summary.failed).toBe(1)
			// Kept suspended (not torn_down) so the grace sweep retries.
			expect((await app.db.orders.getOrder(order.id))?.lifecycle).toBe('suspended')
		})

		it('Throws EntityNotFound for an unknown order', async () => {
			await expect(app.accountService.runLifecycleAction('order-nope', 'suspend')).rejects.toThrow(
				EntityNotFound
			)
		})

		// MARK: wave-10 delivery-lifecycle-followups

		const seedService = async (
			orderId: string,
			serviceName: string,
			customerTag: string,
			extra: { serviceArn?: string | null; config?: DeployedServiceConfig | null } = {}
		) =>
			app.db.deployedServices.record({
				orderId,
				jobId: 'job-1',
				serviceName,
				customerTag,
				serviceArn:
					extra.serviceArn === undefined
						? `arn:aws:ecs:eu-north-1:0:service/default/${serviceName}`
						: extra.serviceArn,
				image: `ecr/mf-deliverables:${serviceName}`,
				config: extra.config === undefined ? { serviceName } : extra.config,
			})

		it('Teardown deprovisions EVERY recorded fence, not just the newest, and soft-deletes the records', async () => {
			// A rebuilt order: two prior deliveries under distinct job-unique fences, plus the newest
			// slug on the order row.
			const { order } = await seedDeliveredOrder('app-newest-33333333')
			await seedService(order.id, 'mf-11111111-app', 'app-11111111')
			await seedService(order.id, 'mf-22222222-app', 'app-22222222')

			const result = await app.accountService.runLifecycleAction(order.id, 'teardown', {
				confirm: true,
			})

			// One deprovision per distinct fence tag (the two recorded + the order slug), all torn down
			expect(app.org.deprovision).toHaveBeenCalledTimes(3)
			const tags = vi.mocked(app.org.deprovision).mock.calls.map(call => call[0].customerSlug)
			expect(tags.sort()).toEqual(['app-11111111', 'app-22222222', 'app-newest-33333333'])
			expect(result.applied).toBe(true)
			expect(result.to).toBe('torn_down')
			// The records are soft-deleted so a torn-down order lists no live services
			expect(await app.db.deployedServices.listForOrder(order.id)).toHaveLength(0)
		})

		it('Resume re-stands-up the recorded services (redeploy) and writes back the new arns', async () => {
			const { order } = await seedDeliveredOrder('app-11111111')
			// Suspended: the service was deleted (arn nulled), the record + config retained
			await seedService(order.id, 'mf-11111111-app', 'app-11111111', { serviceArn: null })
			await app.db.orders.setLifecycle(order.id, ['active'], 'suspended')

			const result = await app.accountService.runLifecycleAction(order.id, 'resume', {
				confirm: true,
			})

			// It replays via redeploy (NOT a tag-discovery deprovision — the service is gone)
			expect(app.org.redeploy).toHaveBeenCalledTimes(1)
			expect(vi.mocked(app.org.redeploy).mock.calls[0]![0]).toEqual([
				{ id: expect.any(String), serviceName: 'mf-11111111-app', config: { serviceName: 'mf-11111111-app' } },
			])
			expect(result.to).toBe('active')
			expect((await app.db.orders.getOrder(order.id))?.lifecycle).toBe('active')
			// The re-created service's new arn is persisted onto the record
			const [row] = await app.db.deployedServices.listForOrder(order.id)
			expect(row!.serviceArn).toBe(
				'arn:aws:ecs:eu-north-1:000000000000:service/default/mf-11111111-app'
			)
		})

		it('Suspend nulls the recorded services arns (compute deleted, config retained for resume)', async () => {
			const { order } = await seedDeliveredOrder('app-11111111')
			await seedService(order.id, 'mf-11111111-app', 'app-11111111')

			await app.accountService.runLifecycleAction(order.id, 'suspend', { confirm: true })

			const [row] = await app.db.deployedServices.listForOrder(order.id)
			expect(row!.serviceArn).toBeUndefined()
			expect(row!.config).toEqual({ serviceName: 'mf-11111111-app' })
		})

		it('Resume is dry-run by default — nothing is re-stood-up and the state is unchanged', async () => {
			const { order } = await seedDeliveredOrder('app-11111111')
			await seedService(order.id, 'mf-11111111-app', 'app-11111111', { serviceArn: null })
			await app.db.orders.setLifecycle(order.id, ['active'], 'suspended')

			const result = await app.accountService.runLifecycleAction(order.id, 'resume')

			expect(result.dryRun).toBe(true)
			expect(app.org.redeploy).toHaveBeenCalledWith(expect.anything(), { dryRun: true })
			expect((await app.db.orders.getOrder(order.id))?.lifecycle).toBe('suspended')
		})
	})
})

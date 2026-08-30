import fp from 'fastify-plugin'

import { createMockDeprovisionResult } from '#/plugins/__mocks__/org.ts'

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import type { LifecycleAction, LifecycleState, Order, Org } from '@mf/models'

const mockOrg: Org = {
	id: 'org-1',
	name: 'Acme',
	awsAccountId: '123456789012',
	awsAccountSlug: 'acme',
	createdAt: '2026-08-01T00:00:00.000Z',
}

const mockOrder: Order = {
	id: 'order-1',
	orgId: 'org-1',
	name: 'Acme gym booking',
	status: 'delivered',
	lifecycle: 'active',
	customerSlug: 'acme-gym-booking-11111111',
	createdAt: '2026-08-01T00:00:00.000Z',
	updatedAt: '2026-08-01T00:00:00.000Z',
}

const mockPlugin: FastifyPluginAsync = async app => {
	const mock: FastifyInstance['accountService'] = {
		provisionCustomerAccount: vi.fn(async () => ({
			skipped: false,
			org: mockOrg,
			accountId: '123456789012',
			reused: false,
		})),
		runLifecycleAction: vi.fn(
			async (_orderId: string, action: LifecycleAction, options?: { confirm?: boolean }) => {
				const dryRun = !(options?.confirm ?? false)
				const to: LifecycleState =
					action === 'teardown' ? 'torn_down' : action === 'suspend' ? 'suspended' : 'active'
				return {
					action,
					dryRun,
					order: { ...mockOrder, lifecycle: dryRun ? mockOrder.lifecycle : to },
					from: mockOrder.lifecycle,
					to,
					applied: !dryRun,
					deprovision: createMockDeprovisionResult(action, {
						dryRun,
						customerSlug: mockOrder.customerSlug,
					}),
				}
			}
		),
	}

	app.decorate('accountService', mock)
}

export default fp(mockPlugin, { name: '#internal/accountService' })

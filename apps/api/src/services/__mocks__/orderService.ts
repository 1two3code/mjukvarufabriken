import fp from 'fastify-plugin'
import { mergeDeep } from '@mf/utils/object'

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import type { PartialDeep } from 'type-fest'
import type { Order, OrderDetail, OrderKind } from '@mf/models'

const defaultOrder: Order = {
	id: 'order-1',
	orgId: 'org-1',
	name: 'Gym booking',
	status: 'drafting',
	kind: 'build',
	lifecycle: 'active',
	createdAt: '2026-08-26T10:00:00.000Z',
	updatedAt: '2026-08-26T10:00:00.000Z',
}

const defaultDetail: OrderDetail = {
	order: defaultOrder,
	spec: { status: 'drafting', complete: false, openQuestions: 1 },
	jobs: [],
	hosting: { status: 'none', deployUrl: null, reason: null },
	payments: [],
}

export const createMockOrder = (overrides?: PartialDeep<Order>): Order =>
	mergeDeep(defaultOrder, overrides)
export const createMockOrderDetail = (overrides?: PartialDeep<OrderDetail>): OrderDetail =>
	mergeDeep(defaultDetail, overrides)

const mockPlugin: FastifyPluginAsync = async app => {
	const mock: FastifyInstance['orderService'] = {
		create: vi.fn((name: string, _session, kind: OrderKind = 'build') =>
			Promise.resolve(createMockOrder({ name, kind }))
		),
		list: vi.fn().mockResolvedValue([createMockOrder()]),
		get: vi.fn((id: string) => Promise.resolve(createMockOrder({ id }))),
		getDetail: vi.fn((id: string) => Promise.resolve(createMockOrderDetail({ order: { id } }))),
		transition: vi.fn((id: string, status) => Promise.resolve(createMockOrder({ id, status }))),
		approve: vi.fn((id: string) => Promise.resolve(createMockOrder({ id, status: 'delivered' }))),
		setApprovalGate: vi.fn((id: string, enabled: boolean) =>
			Promise.resolve(createMockOrder({ id, approveBeforeDeliver: enabled }))
		),
		cancel: vi.fn((id: string) => Promise.resolve(createMockOrder({ id, status: 'cancelled' }))),
		startBuild: vi.fn().mockResolvedValue(undefined),
		approveDemoBuild: vi.fn((id: string) =>
			Promise.resolve(
				createMockOrder({
					id,
					kind: 'demo',
					status: 'building',
					buildApprovedAt: '2026-09-02T10:00:00.000Z',
				})
			)
		),
		demoQueue: vi.fn().mockResolvedValue({
			orders: [createMockOrder({ id: 'order-demo', kind: 'demo', status: 'deposit_paid' })],
			approvedThisWeek: 1,
			cap: 5,
		}),
	}

	app.decorate('orderService', mock)
}

export default fp(mockPlugin, { name: '#internal/orderService' })

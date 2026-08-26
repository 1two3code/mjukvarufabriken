import fp from 'fastify-plugin'
import { mergeDeep } from '@mf/utils/object'

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import type { PartialDeep } from 'type-fest'
import type { Order, OrderDetail } from '@mf/models'

const defaultOrder: Order = {
	id: 'order-1',
	orgId: 'org-1',
	name: 'Gym booking',
	status: 'drafting',
	createdAt: '2026-08-26T10:00:00.000Z',
	updatedAt: '2026-08-26T10:00:00.000Z',
}

const defaultDetail: OrderDetail = {
	order: defaultOrder,
	spec: { status: 'drafting', complete: false, openQuestions: 1 },
	payments: [],
}

export const createMockOrder = (overrides?: PartialDeep<Order>): Order =>
	mergeDeep(defaultOrder, overrides)
export const createMockOrderDetail = (overrides?: PartialDeep<OrderDetail>): OrderDetail =>
	mergeDeep(defaultDetail, overrides)

const mockPlugin: FastifyPluginAsync = async app => {
	const mock: FastifyInstance['orderService'] = {
		create: vi.fn((name: string) => Promise.resolve(createMockOrder({ name }))),
		list: vi.fn().mockResolvedValue([createMockOrder()]),
		get: vi.fn((id: string) => Promise.resolve(createMockOrder({ id }))),
		getDetail: vi.fn((id: string) => Promise.resolve(createMockOrderDetail({ order: { id } }))),
		transition: vi.fn((id: string, status) => Promise.resolve(createMockOrder({ id, status }))),
		cancel: vi.fn((id: string) => Promise.resolve(createMockOrder({ id, status: 'cancelled' }))),
	}

	app.decorate('orderService', mock)
}

export default fp(mockPlugin, { name: '#internal/orderService' })

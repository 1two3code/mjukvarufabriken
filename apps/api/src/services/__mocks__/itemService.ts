import fp from 'fastify-plugin'
import { mergeDeep } from '@template/utils/object'

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import type { PartialDeep } from 'type-fest'
import type { Item } from '@template/models'

const defaultItem: Item = {
	id: 'item-1',
	name: 'Planet Express ship',
	description: 'Intergalactic delivery vessel',
	status: 'active',
	createdAt: '2025-01-01T00:00:00.000Z',
}

export const createMockItem = (overrides?: PartialDeep<Item>) => mergeDeep(defaultItem, overrides)

const mockPlugin: FastifyPluginAsync = async app => {
	const mock: FastifyInstance['itemService'] = {
		create: vi.fn(),
		find: vi.fn().mockResolvedValue([createMockItem()]),
		get: vi.fn((id: string) => Promise.resolve(createMockItem({ id }))),
		update: vi.fn(),
	}

	app.decorate('itemService', mock)
}

export default fp(mockPlugin, { name: '#internal/itemService' })

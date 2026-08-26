import fp from 'fastify-plugin'

import { EntityNotFound } from '#/lib/entityError.ts'

import type { FastifyPluginAsync } from 'fastify'
import type { Item, ItemMutation, ItemQuery } from '@mf/models'

declare module 'fastify' {
	interface FastifyInstance {
		itemService: {
			create: (item: ItemMutation['CreateItem']) => Promise<string>
			find: (filter?: ItemQuery['GetItems']) => Promise<Item[]>
			get: (id: string) => Promise<Item>
			update: (id: string, updates: ItemMutation['UpdateItem']) => Promise<void>
		}
	}
}

const collection = 'items'

const matchesFilter = (item: Item, filter: ItemQuery['GetItems']) => {
	const matchesStatus = !filter.status || item.status === filter.status
	const search = filter.search?.trim().toLowerCase()
	const matchesSearch = !search || item.name.toLowerCase().includes(search)
	return matchesStatus && matchesSearch
}

const plugin: FastifyPluginAsync = async app => {
	const { store } = app

	app.decorate('itemService', {
		create: async item => {
			const newItem: Item = {
				...item,
				id: crypto.randomUUID(),
				status: 'draft',
				createdAt: new Date().toISOString(),
			}
			await store.put(collection, newItem.id, newItem)
			return newItem.id
		},
		find: async filter => {
			const items = await store.list<Item>(collection)
			if (!filter) return items
			return items.filter(item => matchesFilter(item, filter))
		},
		get: async id => {
			const item = await store.get<Item>(collection, id)
			if (!item) throw new EntityNotFound('item', id)
			return item
		},
		update: async (id, updates) => {
			const item = await app.itemService.get(id)
			await store.put(collection, id, { ...item, ...updates })
		},
	})
}

export default fp(plugin, { name: '#internal/itemService', dependencies: ['#internal/store'] })

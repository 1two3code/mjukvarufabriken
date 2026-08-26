import fp from 'fastify-plugin'

import type { FastifyPluginAsync } from 'fastify'

declare module 'fastify' {
	interface FastifyInstance {
		store: {
			get: <T>(collection: string, id: string) => Promise<T | undefined>
			list: <T>(collection: string) => Promise<T[]>
			put: <T>(collection: string, id: string, value: T) => Promise<void>
			delete: (collection: string, id: string) => Promise<boolean>
		}
	}
}

/**
 * In-memory key/value store keyed by collection. It exists so the template runs
 * without external services; replace it with a real database client (DynamoDB,
 * Postgres, …) while keeping the same interface so services stay untouched.
 */
const plugin: FastifyPluginAsync = async app => {
	const collections = new Map<string, Map<string, unknown>>()

	const getCollection = (name: string) => {
		const existing = collections.get(name)
		if (existing) return existing
		const created = new Map<string, unknown>()
		collections.set(name, created)
		return created
	}

	app.decorate('store', {
		get: async (collection, id) => {
			const value = getCollection(collection).get(id)
			return value === undefined ? undefined : structuredClone(value as never)
		},
		list: async collection =>
			[...getCollection(collection).values()].map(x => structuredClone(x as never)),
		put: async (collection, id, value) => {
			getCollection(collection).set(id, structuredClone(value))
		},
		delete: async (collection, id) => getCollection(collection).delete(id),
	})

	app.addHook('onClose', async () => collections.clear())
}

export default fp(plugin, { name: '#internal/store' })

import fp from 'fastify-plugin'
import postgres from 'postgres'

import { createMemoryStore, createPostgresStore } from '#/plugins/store.utils.ts'

import type { FastifyPluginAsync } from 'fastify'
import type { StoreBackend } from '#/plugins/store.utils.ts'

declare module 'fastify' {
	interface FastifyInstance {
		store: StoreBackend
	}
}

/**
 * The app's persistence: a key/value store keyed by collection, durable on Postgres.
 *
 * With `DATABASE_URL` set (every deployed environment — the platform provisions a database for
 * each delivered app and injects the URL) values live in a Postgres table and survive restarts,
 * redeploys and scaling. Without it (local development, tests) the same interface runs in memory
 * so the template works with no external services.
 *
 * USE THIS for anything the app must remember — do not add a second database client, an ORM or
 * a hand-rolled table layer for ordinary records; `app.store` already is the database. Reach for
 * raw SQL only when a feature genuinely needs relational queries the key/value contract cannot
 * express, and then keep using `DATABASE_URL`.
 */
const plugin: FastifyPluginAsync = async app => {
	const url = process.env.DATABASE_URL
	const store = url ? durableStore(url) : createMemoryStore()

	if (store.kind === 'memory') {
		app.log.warn('store: DATABASE_URL is not set — data is kept in memory and lost on restart')
	} else {
		app.log.info('store: durable on Postgres')
	}

	app.decorate('store', store)
	app.addHook('onClose', () => store.close())
}

/** Connects lazily (first query), fails fast on an unreachable host, honours `?sslmode=` in the URL */
const durableStore = (url: string) => {
	const sql = postgres(url, { connect_timeout: 10, max: 5 })
	return createPostgresStore(
		(text, params = []) => sql.unsafe(text, params as never),
		() => sql.end({ timeout: 5 })
	)
}

export default fp(plugin, { name: '#internal/store' })

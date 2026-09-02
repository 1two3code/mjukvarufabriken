/**
 * The two backends of the `store` plugin. Both implement the same collection/id/value contract;
 * `createPostgresStore` is written over an injected `query` so it can be tested without a server.
 */

export type StoreValue = Record<string, unknown> | unknown

export type StoreBackend = {
	/** Which backend is live: `postgres` is durable across restarts, `memory` is not */
	kind: 'memory' | 'postgres'
	get: <T>(collection: string, id: string) => Promise<T | undefined>
	list: <T>(collection: string) => Promise<T[]>
	put: <T>(collection: string, id: string, value: T) => Promise<void>
	delete: (collection: string, id: string) => Promise<boolean>
	close: () => Promise<void>
}

/** A parameterised query (`$1`, `$2`, …) returning its rows — the only thing the Postgres store needs */
export type Query = (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>

// MARK: In-memory

/** Process-local backend for local development and tests: everything is gone on restart */
export const createMemoryStore = (): StoreBackend => {
	const collections = new Map<string, Map<string, unknown>>()

	const getCollection = (name: string) => {
		const existing = collections.get(name)
		if (existing) return existing
		const created = new Map<string, unknown>()
		collections.set(name, created)
		return created
	}

	return {
		kind: 'memory',
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
		close: async () => collections.clear(),
	}
}

// MARK: Postgres

/**
 * `sslmode` in a connection URL, translated for the `postgres` driver. The platform (and most
 * hosting) writes node-postgres vocabulary — `?sslmode=no-verify` for "encrypted, certificate
 * not verified" — which `postgres` does not know and therefore treats as full verification. That
 * failed the first live delivery with SELF_SIGNED_CERT_IN_CHAIN against the managed database.
 * Returns the driver's `ssl` option; the URL is handed over without the parameter so the driver
 * cannot re-read it differently.
 */
export const sslOptionOf = (
	url: string
): { url: string; ssl: false | 'verify-full' | { rejectUnauthorized: false } } => {
	let parsed: URL
	try {
		parsed = new URL(url)
	} catch {
		return { url, ssl: false }
	}
	const mode = (parsed.searchParams.get('sslmode') ?? '').toLowerCase()
	parsed.searchParams.delete('sslmode')
	const cleaned = parsed.toString()
	if (mode === 'disable') return { url: cleaned, ssl: false }
	if (mode === 'verify-full' || mode === 'verify-ca') return { url: cleaned, ssl: 'verify-full' }
	if (mode === 'no-verify' || mode === 'require' || mode === 'prefer' || mode === 'allow') {
		return { url: cleaned, ssl: { rejectUnauthorized: false } }
	}
	return { url: cleaned, ssl: false }
}

/** One table for every collection: the value is JSONB, the key is (collection, id) */
export const storeTable = 'store'

/**
 * Created lazily on the first operation, so an app boots (and its health check answers) before
 * the database is reachable, and a fresh provisioned database needs no separate migration step.
 */
export const ensureTableSql = `CREATE TABLE IF NOT EXISTS ${storeTable} (
	collection text NOT NULL,
	id text NOT NULL,
	value jsonb NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (collection, id)
)`

/**
 * Durable backend over Postgres. Same semantics as the in-memory one: `list` returns values in
 * insertion order (a `put` on an existing id keeps its place), values round-trip through JSON.
 * The store never connects until the first operation — see `ensureTableSql`.
 */
export const createPostgresStore = (query: Query, close: () => Promise<void>): StoreBackend => {
	let ready: Promise<void> | undefined
	const ensureTable = () => {
		ready ??= query(ensureTableSql).then(() => undefined)
		return ready
	}

	return {
		kind: 'postgres',
		get: async (collection, id) => {
			await ensureTable()
			const rows = await query(
				`SELECT value FROM ${storeTable} WHERE collection = $1 AND id = $2`,
				[collection, id]
			)
			return rows[0]?.value as never
		},
		list: async collection => {
			await ensureTable()
			const rows = await query(
				`SELECT value FROM ${storeTable} WHERE collection = $1 ORDER BY created_at, id`,
				[collection]
			)
			return rows.map(row => row.value as never)
		},
		put: async (collection, id, value) => {
			await ensureTable()
			await query(
				`INSERT INTO ${storeTable} (collection, id, value) VALUES ($1, $2, $3::jsonb)
				ON CONFLICT (collection, id) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
				[collection, id, JSON.stringify(value)]
			)
		},
		delete: async (collection, id) => {
			await ensureTable()
			const rows = await query(
				`DELETE FROM ${storeTable} WHERE collection = $1 AND id = $2 RETURNING id`,
				[collection, id]
			)
			return rows.length > 0
		},
		close,
	}
}

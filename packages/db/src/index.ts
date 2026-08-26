/**
 * Postgres layer skeleton. Migrations live in `migrations/*.sql` and are applied in file order.
 * No driver dependency yet — `pg` (or `postgres`) is added when the api swaps its in-memory
 * `store` plugin for this layer.
 */

export type Db = {
	connectionString: string
	/** Run a parameterised query. Placeholder until a driver is wired in. */
	query: <T>(sql: string, params?: unknown[]) => Promise<T[]>
	close: () => Promise<void>
}

export const createDb = (connectionString: string): Db => {
	if (!connectionString) throw new Error('createDb: connectionString is required')

	return {
		connectionString,
		query: async () => {
			throw new Error('Database driver not wired yet')
		},
		close: async () => {},
	}
}

/**
 * Postgres layer: `createDb` wraps the porsager `postgres` driver, `migrate` applies
 * `migrations/*.sql` in file order, and the repositories are plain functions over a `Db`.
 * Consumers (api, job) resolve the connection string themselves — from `DATABASE_URL` or a
 * Secrets Manager secret via `connectionStringFromSecret`.
 */

import postgres from 'postgres'

import type { Sql } from 'postgres'

export * from './jobs.ts'
export * from './migrate.ts'

export type Db = {
	sql: Sql
	/** Run a parameterised query (`$1`, `$2`, …) and return the rows */
	query: <T extends Record<string, unknown> = Record<string, unknown>>(
		text: string,
		params?: unknown[]
	) => Promise<T[]>
	close: () => Promise<void>
}

/** Hosts that get a plaintext connection by default (local docker compose / CI) */
const localHosts = new Set(['localhost', '127.0.0.1', '::1', 'postgres'])

/**
 * RDS Postgres 15+ forces SSL (`rds.force_ssl=1`), so everything that is not a local host
 * connects with TLS. `require` encrypts without verifying the server certificate — pinning
 * the RDS CA bundle is a follow-up (M9). Override with `DATABASE_SSL=disable|require|verify-full`.
 */
export const sslMode = (connectionString: string): false | 'require' | 'verify-full' => {
	const override = process.env.DATABASE_SSL
	if (override === 'disable') return false
	if (override === 'verify-full' || override === 'require') return override
	let host = ''
	try {
		host = new URL(connectionString).hostname
	} catch {
		return 'require'
	}
	return localHosts.has(host) ? false : 'require'
}

export const createDb = (connectionString: string, options?: { max?: number }): Db => {
	if (!connectionString) throw new Error('createDb: connectionString is required')

	const sql = postgres(connectionString, {
		max: options?.max ?? 5,
		ssl: sslMode(connectionString),
		// Bigint/numeric columns come back as JS numbers — every integer here fits comfortably
		transform: { undefined: null },
		types: { bigint: postgres.BigInt },
		onnotice: () => {},
	})

	return {
		sql,
		query: async (text, params = []) => (await sql.unsafe(text, params as never)) as never,
		close: () => sql.end({ timeout: 5 }),
	}
}

/** Shape of the secret RDS generates for the instance (see `resources-stack.ts`) */
export type DatabaseSecret = {
	username: string
	password: string
	host: string
	port: number | string
	dbname?: string
}

export const connectionStringFromSecret = (secret: DatabaseSecret) => {
	const { username, password, host, port, dbname = 'mf' } = secret
	const auth = `${encodeURIComponent(username)}:${encodeURIComponent(password)}`
	return `postgres://${auth}@${host}:${port}/${dbname}`
}

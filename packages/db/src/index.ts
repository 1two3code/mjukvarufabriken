/**
 * Postgres layer: `createDb` wraps the porsager `postgres` driver, `migrate` applies
 * `migrations/*.sql` in file order, and the repositories are plain functions over a `Db`.
 * Consumers (api, job) resolve the connection string themselves — from `DATABASE_URL` or a
 * Secrets Manager secret via `connectionStringFromSecret`.
 */

import { readFileSync } from 'node:fs'

import postgres from 'postgres'

import { createAuthRepository } from './auth.ts'
import { createIterationBriefRepository } from './iterationBrief.ts'
import { createDeployedServicesRepository } from './deployedServices.ts'
import { createJobsRepository } from './jobs.ts'
import { createModelPricesRepository } from './modelPrices.ts'
import { createOrdersRepository } from './orders.ts'
import { createResidentRepository } from './resident.ts'
import { createRateLimitsRepository } from './rateLimits.ts'
import { createUsersRepository } from './users.ts'

import type { Sql } from 'postgres'
import type { Repositories } from './repositories.ts'

export * from './auth.ts'
export * from './iterationBrief.ts'
export * from './deployedServices.ts'
export * from './jobs.ts'
export * from './memory.ts'
export * from './migrate.ts'
export * from './modelPrices.ts'
export * from './orders.ts'
export * from './rateLimits.ts'
export * from './repositories.ts'
export * from './resident.ts'
export * from './users.ts'

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

/** Amazon RDS endpoints (`<id>.<hash>.<region>.rds.amazonaws.com`, incl. proxies and clusters) */
export const isRdsHost = (host: string) => /(^|\.)rds\.amazonaws\.com$/i.test(host)

export type SslMode = false | 'require' | 'verify-full'

/**
 * RDS Postgres 15+ forces SSL (`rds.force_ssl=1`), so everything that is not a local host
 * connects with TLS. RDS hosts get `verify-full`: the server certificate is checked against
 * the RDS global CA bundle this package ships (`sslOptions`, M9) and the host name must
 * match. Any other remote host gets `require` (encrypted, unverified — its CA
 * is not in the bundle). `DATABASE_SSL=disable|require|verify-full` is an explicit override,
 * e.g. `require` when connecting to RDS from a machine without the bundle.
 */
export const sslMode = (connectionString: string, env = process.env): SslMode => {
	const override = env.DATABASE_SSL?.trim()
	if (override === 'disable') return false
	if (override === 'verify-full' || override === 'require') return override
	let host: string
	try {
		host = new URL(connectionString).hostname
	} catch {
		return 'require'
	}
	if (localHosts.has(host)) return false
	return isRdsHost(host) ? 'verify-full' : 'require'
}

/**
 * The RDS global CA bundle shipped with this package (`certs/rds-global-bundle.pem`, pinned
 * by commit — refresh it from https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
 * when AWS rotates CAs). `DATABASE_SSL_CA=/path.pem` points at another bundle.
 */
export const rdsCaBundlePath = (env = process.env) =>
	env.DATABASE_SSL_CA?.trim() || new URL('../certs/rds-global-bundle.pem', import.meta.url)

/**
 * The driver's `ssl` option for the mode: `verify-full` trusts the RDS bundle only — for this
 * connection, not process-wide like `NODE_EXTRA_CA_CERTS` would — and the driver checks the
 * host name against the certificate (it sets `servername`). `require` is encrypted without
 * verification.
 */
export const sslOptions = (
	mode: SslMode,
	env = process.env
): false | { rejectUnauthorized: boolean; ca?: string } => {
	if (mode === false) return false
	if (mode === 'require') return { rejectUnauthorized: false }
	return { rejectUnauthorized: true, ca: readFileSync(rdsCaBundlePath(env), 'utf8') }
}

export const createDb = (connectionString: string, options?: { max?: number }): Db => {
	if (!connectionString) throw new Error('createDb: connectionString is required')

	const sql = postgres(connectionString, {
		max: options?.max ?? 5,
		ssl: sslOptions(sslMode(connectionString)),
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

/** Every repository over one Postgres connection pool */
export const createPostgresRepositories = (db: Db): Repositories => ({
	jobs: createJobsRepository(db),
	modelPrices: createModelPricesRepository(db),
	iterationBrief: createIterationBriefRepository(db),
	orders: createOrdersRepository(db),
	deployedServices: createDeployedServicesRepository(db),
	users: createUsersRepository(db),
	auth: createAuthRepository(db),
	resident: createResidentRepository(db),
	rateLimits: createRateLimitsRepository(db),
})

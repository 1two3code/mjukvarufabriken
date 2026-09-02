/**
 * Per-delivery database provisioning (Gate C, docs/DELIVERED-DB.md — audit finding D1): a
 * delivered app that needs persistence used to ship against a database that never existed and
 * 500 on every read/write. This service creates a dedicated database + login role for one job's
 * delivered app on the platform's Postgres server and returns the scoped connection string.
 *
 * Security shape: the BUILD CONTAINER never holds the admin credentials — it calls
 * `POST /internal/jobs/:jobId/database` with its per-job report token, and only the scoped URL
 * travels back. The admin connection lives here, in the api (which already holds the platform
 * database credentials). The provisioned role is LOGIN-only (no SUPERUSER/CREATEDB/CREATEROLE),
 * owns exactly its own database, and PUBLIC's default connect grant on that database is revoked
 * so no other delivered app's role can reach it.
 */
import { randomBytes } from 'node:crypto'

import fp from 'fastify-plugin'
import { createDb } from '@mf/db'

import { resolveConnectionString } from '#/plugins/db.ts'

import type { FastifyPluginAsync } from 'fastify'
import type { PreviewTeardownOutcome } from '@mf/models'

declare module 'fastify' {
	interface FastifyInstance {
		previewDbService: {
			/**
			 * Creates (or re-keys, on redelivery) the job's database + role and returns the scoped
			 * connection string. Throws `ProvisioningUnavailable` when no admin database is
			 * configured — the job then fails its deploy closed instead of shipping a dead app.
			 */
			provision: (jobId: string) => Promise<{ databaseUrl: string }>
			/**
			 * The final export of the job's database (wave 14): every table in `public` as
			 * `{ table, columns, rows }`. Resolves to `undefined` when the job never had a database
			 * (no admin connection configured, or no such database) — the export then skips it.
			 */
			dump: (jobId: string) => Promise<PreviewDatabaseDump | undefined>
			/**
			 * Drops the job's database and role at order teardown (wave 14). Idempotent: a missing
			 * database / role reports `already-gone`; without an admin connection both are `skipped`.
			 */
			teardown: (jobId: string) => Promise<PreviewDatabaseTeardown>
		}
	}
}

/** One table of a delivered app's database, as exported (`database.json`) */
export type PreviewTableDump = {
	table: string
	columns: string[]
	rows: Record<string, unknown>[]
	/** True when the table held more than `maxDumpRowsPerTable` rows and only the first were taken */
	truncated: boolean
}

export type PreviewDatabaseDump = {
	database: string
	exportedAt: string
	tables: PreviewTableDump[]
}

export type PreviewDatabaseTeardown = {
	database: PreviewTeardownOutcome
	role: PreviewTeardownOutcome
	reason?: string
}

/** A table larger than this is exported truncated — the export is a courtesy copy, not a backup service */
export const maxDumpRowsPerTable = 100_000

export class ProvisioningUnavailable extends Error {}

// MARK: Pure helpers (exported for tests)

/**
 * The delivered app's database AND role name, derived from the job id: `mf_app_<jobid16>`.
 * Strictly `[a-z0-9_]` — the SQL below interpolates it as an identifier, so anything else must
 * be impossible, not merely unexpected. Deterministic, so a redelivery of the same job reuses
 * (re-keys) its database instead of leaking a new one per attempt.
 */
export const previewDbName = (jobId: string): string => {
	const cleaned = jobId
		.toLowerCase()
		.replace(/[^a-z0-9]/g, '')
		.slice(0, 16)
	if (cleaned.length < 4) {
		throw new Error(`previewDbName: job id '${jobId}' is too short to derive a database name`)
	}
	return `mf_app_${cleaned}`
}

/** base64url: `[A-Za-z0-9_-]` only — safe inside both a quoted SQL literal and a URL */
export const generateDbPassword = (): string => randomBytes(24).toString('base64url')

/**
 * The connection string handed to the delivered container. Host/port come from the admin
 * connection (same server) unless `hostOverride` (`host[:port]`) says otherwise — e.g. local
 * docker where the api reaches Postgres as `localhost` but a delivered container must not.
 * Remote hosts get `sslmode=no-verify` (encrypted, unverified — the delivered app has no CA
 * bundle; same trade-off as @mf/db's `require` mode), local ones stay plain.
 */
export const previewDatabaseUrl = (
	adminUrl: string,
	name: string,
	password: string,
	hostOverride?: string
): string => {
	const admin = new URL(adminUrl)
	const [host = admin.hostname, port] = hostOverride
		? [hostOverride.split(':')[0], hostOverride.split(':')[1]]
		: [admin.hostname, admin.port || undefined]
	const local = ['localhost', '127.0.0.1', '::1', 'postgres'].includes(host!)
	return (
		`postgres://${name}:${password}@${host}${port ? `:${port}` : ''}/${name}` +
		(local ? '' : '?sslmode=no-verify')
	)
}

// MARK: Provisioning

/** The slice of `@mf/db`'s Db the provisioning runs on (injectable in tests) */
export type AdminDb = {
	query: <T extends Record<string, unknown> = Record<string, unknown>>(
		text: string,
		params?: unknown[]
	) => Promise<T[]>
}

/**
 * Idempotently provisions the role + database for one job. A redelivery re-keys the existing
 * role (a fresh password every time — only the latest delivered container knows it) and keeps
 * the database and its data. `name` is derived (strict `[a-z0-9_]`) and `password` is base64url,
 * so the interpolations below cannot carry SQL; everything user-shaped stays parameterised.
 * `GRANT <role> TO CURRENT_USER` is the RDS dance: the master user is not a superuser and may
 * only create a database owned by a role it is a member of.
 */
export const provisionPreviewDatabase = async (
	db: AdminDb,
	jobId: string
): Promise<{ name: string; password: string }> => {
	const name = previewDbName(jobId)
	const password = generateDbPassword()
	const roleExists =
		(await db.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [name])).length > 0
	// Re-key only on the redelivery path: the attributes were fixed at creation, and the RDS master
	// user (rds_superuser, not SUPERUSER) may not even restate NOSUPERUSER — `ALTER ROLE … NOSUPERUSER`
	// is 42501 "only roles with the SUPERUSER attribute may change the SUPERUSER attribute". That
	// exact statement failed the first redelivery (job 3583768f, 2026-09-02).
	await db.query(
		roleExists
			? `ALTER ROLE ${name} WITH PASSWORD '${password}'`
			: `CREATE ROLE ${name} WITH LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE CONNECTION LIMIT 20`
	)
	await db.query(`GRANT ${name} TO CURRENT_USER`)
	const dbExists =
		(await db.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).length > 0
	if (!dbExists) await db.query(`CREATE DATABASE ${name} OWNER ${name}`)
	else await db.query(`ALTER DATABASE ${name} OWNER TO ${name}`)
	await db.query(`REVOKE CONNECT ON DATABASE ${name} FROM PUBLIC`)
	await db.query(`GRANT CONNECT ON DATABASE ${name} TO ${name}`)
	return { name, password }
}

// MARK: Export + teardown

/**
 * The exact shape every name this file interpolates as an identifier must have. `previewDbName`
 * can only ever produce it, but the DROP statements below are the destructive path, so the guard
 * is restated right where it matters rather than trusted from a distance.
 */
export const previewDbNamePattern = /^mf_app_[a-z0-9]{4,16}$/

const assertPreviewDbName = (name: string) => {
	if (!previewDbNamePattern.test(name)) {
		throw new Error(`refusing to touch '${name}': not a preview database name`)
	}
	return name
}

/** `"name"` with embedded quotes doubled — the delivered app chose its own table names */
const quoteIdentifier = (name: string) => `"${name.replace(/"/g, '""')}"`

const databaseExists = async (db: AdminDb, name: string) =>
	(await db.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).length > 0

const roleExists = async (db: AdminDb, name: string) =>
	(await db.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [name])).length > 0

/**
 * Reads every `public` base table of the app's database through a connection to THAT database
 * (`connect` receives the database name — the admin user reaches it through its membership of
 * the owning role, granted at provisioning). Column order comes from the catalogue so an empty
 * table still exports its shape.
 */
export const dumpPreviewDatabase = async (
	appDb: AdminDb,
	name: string
): Promise<Omit<PreviewDatabaseDump, 'exportedAt'>> => {
	assertPreviewDbName(name)
	const tables = await appDb.query<{ table_name: string }>(
		`SELECT table_name FROM information_schema.tables
		 WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
		 ORDER BY table_name`
	)
	const dumped: PreviewTableDump[] = []
	for (const { table_name: table } of tables) {
		const columns = await appDb.query<{ column_name: string }>(
			`SELECT column_name FROM information_schema.columns
			 WHERE table_schema = 'public' AND table_name = $1
			 ORDER BY ordinal_position`,
			[table]
		)
		const rows = await appDb.query(
			`SELECT * FROM ${quoteIdentifier(table)} LIMIT ${maxDumpRowsPerTable + 1}`
		)
		dumped.push({
			table,
			columns: columns.map(column => column.column_name),
			rows: rows.slice(0, maxDumpRowsPerTable),
			truncated: rows.length > maxDumpRowsPerTable,
		})
	}
	return { database: name, tables: dumped }
}

/**
 * Drops the job's database (forcing its sessions off first) and then its role. Both statements
 * are `IF EXISTS`, and the existence checks feed the report, so a second run is a no-op that
 * still answers truthfully. `WITH (FORCE)` is Postgres 13+ (RDS 17 here).
 */
export const teardownPreviewDatabase = async (
	db: AdminDb,
	jobId: string
): Promise<PreviewDatabaseTeardown> => {
	const name = assertPreviewDbName(previewDbName(jobId))
	const hadDatabase = await databaseExists(db, name)
	if (hadDatabase) await db.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
	const hadRole = await roleExists(db, name)
	if (hadRole) await db.query(`DROP ROLE IF EXISTS ${name}`)
	return {
		database: hadDatabase ? 'deleted' : 'already-gone',
		role: hadRole ? 'deleted' : 'already-gone',
	}
}

/** The admin connection string pointed at the app's own database (same server, same credentials) */
export const adminUrlForDatabase = (adminUrl: string, name: string) => {
	const url = new URL(adminUrl)
	url.pathname = `/${name}`
	return url.toString()
}

// MARK: Plugin

export type PreviewDbOptions = {
	/** Injectable admin-connection factory for tests (default: `createDb` from @mf/db) */
	connect?: (url: string) => AdminDb & { close: () => Promise<void> }
}

const plugin: FastifyPluginAsync<PreviewDbOptions> = async (app, options) => {
	const connect = options.connect ?? ((url: string) => createDb(url, { max: 1 }))
	const resolveAdminUrl = async () =>
		app.secrets.preview.dbAdminUrl ?? (await resolveConnectionString())

	/** Runs `work` on a fresh single-use admin connection to `url`, closing it afterwards */
	const withConnection = async <T>(url: string, work: (db: AdminDb) => Promise<T>) => {
		const admin = connect(url)
		try {
			return await work(admin)
		} finally {
			await admin.close().catch(() => {})
		}
	}

	app.decorate('previewDbService', {
		provision: async jobId => {
			const adminUrl = await resolveAdminUrl()
			if (!adminUrl) {
				throw new ProvisioningUnavailable(
					'no admin database configured (PREVIEW_DB_ADMIN_URL / DATABASE_URL / DATABASE_SECRET_ARN) — cannot provision a delivered-app database'
				)
			}
			// A fresh single-use connection per provisioning (rare: once per delivery): CREATE
			// DATABASE cannot run inside a transaction or pooled statement mix, and holding an
			// admin pool open for an endpoint this cold buys nothing.
			const admin = connect(adminUrl)
			try {
				const { name, password } = await provisionPreviewDatabase(admin, jobId)
				app.log.info({ jobId, database: name }, 'Provisioned the delivered app database')
				return {
					databaseUrl: previewDatabaseUrl(adminUrl, name, password, app.secrets.preview.dbHost),
				}
			} finally {
				await admin.close().catch(() => {})
			}
		},
		dump: async jobId => {
			const adminUrl = await resolveAdminUrl()
			if (!adminUrl) return undefined
			const name = previewDbName(jobId)
			const exists = await withConnection(adminUrl, db => databaseExists(db, name))
			if (!exists) return undefined
			const dump = await withConnection(adminUrlForDatabase(adminUrl, name), db =>
				dumpPreviewDatabase(db, name)
			)
			app.log.info(
				{ jobId, database: name, tables: dump.tables.length },
				'Exported the delivered app database'
			)
			return { ...dump, exportedAt: new Date().toISOString() }
		},
		teardown: async jobId => {
			const adminUrl = await resolveAdminUrl()
			if (!adminUrl) {
				return { database: 'skipped', role: 'skipped', reason: 'no admin database configured' }
			}
			const result = await withConnection(adminUrl, db => teardownPreviewDatabase(db, jobId))
			app.log.info({ jobId, ...result }, 'Tore down the delivered app database')
			return result
		},
	})
}

export default fp(plugin, {
	name: '#internal/previewDbService',
	dependencies: ['#internal/secrets'],
})

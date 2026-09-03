import {
	adminUrlForDatabase,
	dumpPreviewDatabase,
	dumpSessionStatements,
	previewDatabaseUrl,
	previewDbName,
	provisionPreviewDatabase,
	teardownPreviewDatabase,
} from '#/services/previewDbService.ts'

import type { FastifyInstance } from 'fastify'
import type { AdminDb } from '#/services/previewDbService.ts'

/** Records every statement; `existing` marks which pg_roles/pg_database lookups find a row */
const fakeAdminDb = (existing: { role?: boolean; database?: boolean } = {}) => {
	const statements: string[] = []
	const db: AdminDb = {
		query: async <T extends Record<string, unknown>>(text: string) => {
			statements.push(text)
			if (text.includes('pg_roles')) return (existing.role ? [{ ok: 1 }] : []) as unknown as T[]
			if (text.includes('pg_database')) {
				return (existing.database ? [{ ok: 1 }] : []) as unknown as T[]
			}
			return [] as T[]
		},
	}
	return { db, statements }
}

describe('previewDbName', () => {
	it('derives a strict [a-z0-9_] identifier from the job id, deterministically', () => {
		expect(previewDbName('11111111-2222-3333-4444-555555555555')).toBe('mf_app_1111111122223333')
		expect(previewDbName('ABC-def-123')).toBe('mf_app_abcdef123')
	})

	it('refuses a job id too short to be a safe discriminator', () => {
		expect(() => previewDbName('a-!')).toThrow('too short')
	})
})

describe('previewDatabaseUrl', () => {
	it('reuses the admin host/port and appends sslmode for remote hosts', () => {
		expect(
			previewDatabaseUrl(
				'postgres://master:secret@db.rds.amazonaws.com:5432/platform',
				'mf_app_x',
				'pw'
			)
		).toBe('postgres://mf_app_x:pw@db.rds.amazonaws.com:5432/mf_app_x?sslmode=no-verify')
	})

	it('keeps local hosts plaintext and honours the host override', () => {
		expect(previewDatabaseUrl('postgres://u:p@localhost:5432/db', 'mf_app_x', 'pw')).toBe(
			'postgres://mf_app_x:pw@localhost:5432/mf_app_x'
		)
		expect(
			previewDatabaseUrl('postgres://u:p@localhost:5432/db', 'mf_app_x', 'pw', 'db.internal:6432')
		).toBe('postgres://mf_app_x:pw@db.internal:6432/mf_app_x?sslmode=no-verify')
	})
})

describe('teardownPreviewDatabase (wave 14)', () => {
	it('Forces the database off and drops it, then the role — in that order', async () => {
		const { db, statements } = fakeAdminDb({ role: true, database: true })

		const result = await teardownPreviewDatabase(db, 'job-1234-abcd')

		expect(result).toEqual({ database: 'deleted', role: 'deleted' })
		expect(statements).toEqual([
			'SELECT 1 FROM pg_database WHERE datname = $1',
			'DROP DATABASE IF EXISTS mf_app_job1234abcd WITH (FORCE)',
			'SELECT 1 FROM pg_roles WHERE rolname = $1',
			'DROP ROLE IF EXISTS mf_app_job1234abcd',
		])
	})

	it('Is idempotent — a second pass finds nothing and drops nothing, reporting already-gone', async () => {
		const { db, statements } = fakeAdminDb()

		const result = await teardownPreviewDatabase(db, 'job-1234-abcd')

		expect(result).toEqual({ database: 'already-gone', role: 'already-gone' })
		expect(statements.some(text => text.startsWith('DROP'))).toBe(false)
	})

	it('Refuses a job id that cannot derive a preview database name', async () => {
		const { db, statements } = fakeAdminDb({ role: true, database: true })

		await expect(teardownPreviewDatabase(db, 'a-!')).rejects.toThrow(/too short/)
		expect(statements).toEqual([])
	})
})

describe('dumpPreviewDatabase (wave 14)', () => {
	it('Exports every public base table with its catalogue column order, quoting identifiers', async () => {
		const statements: { text: string; params?: unknown[] }[] = []
		const db: AdminDb = {
			query: async <T extends Record<string, unknown>>(text: string, params?: unknown[]) => {
				statements.push({ text, params })
				if (text.includes('information_schema.tables')) {
					return [{ table_name: 'bookings' }, { table_name: 'odd"name' }] as unknown as T[]
				}
				if (text.includes('information_schema.columns')) {
					return [{ column_name: 'id' }, { column_name: 'member' }] as unknown as T[]
				}
				return [{ id: 1, member: 'anna' }] as unknown as T[]
			},
		}

		const dump = await dumpPreviewDatabase(db, 'mf_app_job1234abcd')

		expect(dump.database).toBe('mf_app_job1234abcd')
		expect(dump.tables).toEqual([
			{
				table: 'bookings',
				columns: ['id', 'member'],
				rows: [{ id: 1, member: 'anna' }],
				truncated: false,
			},
			{
				table: 'odd"name',
				columns: ['id', 'member'],
				rows: [{ id: 1, member: 'anna' }],
				truncated: false,
			},
		])
		// Table names come from the delivered app: always schema-qualified (the session's
		// search_path is pg_catalog only), always quoted, embedded quotes doubled
		expect(statements.map(s => s.text)).toContain('SELECT * FROM "public"."bookings" LIMIT 100001')
		expect(statements.map(s => s.text)).toContain('SELECT * FROM "public"."odd""name" LIMIT 100001')
		expect(statements.find(s => s.text.includes('information_schema.columns'))?.params).toEqual([
			'bookings',
		])
	})

	it('Hardens the session to the app role BEFORE the first read — never runs tenant SQL as the admin', async () => {
		// The app role owns its database, so a policy/view/default function of the tenant's making
		// would otherwise run with the reader's (RDS master) privileges during the export sweep.
		const { db, statements } = fakeAdminDb()

		await dumpPreviewDatabase(db, 'mf_app_job1234abcd')

		const setup = dumpSessionStatements('mf_app_job1234abcd')
		expect(setup).toEqual([
			'SET ROLE mf_app_job1234abcd',
			'SET default_transaction_read_only = on',
			'SET row_security = off',
			'SET search_path = pg_catalog',
			'SET statement_timeout = 60000',
		])
		expect(statements.slice(0, setup.length)).toEqual(setup)
		expect(statements.findIndex(text => text.startsWith('SELECT'))).toBe(setup.length)
		// The role name is the fenced identifier, restated where it is interpolated
		expect(() => dumpSessionStatements('postgres')).toThrow(/not a preview database/)
	})

	it('Refuses to dump anything but a preview database name', async () => {
		const { db } = fakeAdminDb()
		await expect(dumpPreviewDatabase(db, 'postgres')).rejects.toThrow(/not a preview database/)
	})

	it('Points the admin connection at the app database, keeping host and credentials', () => {
		expect(
			adminUrlForDatabase('postgres://master:secret@db.example.com:5432/platform', 'mf_app_x')
		).toBe('postgres://master:secret@db.example.com:5432/mf_app_x')
	})
})

describe('previewDbService plugin without an admin database', () => {
	let app: FastifyInstance

	beforeEach(async () => {
		vi.stubEnv('DATABASE_URL', '')
		vi.stubEnv('DATABASE_SECRET_ARN', '')
		app = await createTestApp({ skipMock: '#/services/previewDbService.ts' })
	})

	afterEach(() => vi.unstubAllEnvs())

	it('Skips the dump and the teardown cleanly (nothing could have been provisioned)', async () => {
		await expect(app.previewDbService.dump('job-1234-abcd')).resolves.toBeUndefined()
		await expect(app.previewDbService.teardown('job-1234-abcd')).resolves.toEqual({
			database: 'skipped',
			role: 'skipped',
			reason: 'no admin database configured',
		})
	})
})

describe('provisionPreviewDatabase', () => {
	it('creates a LOGIN-only role + owned database and fences PUBLIC connect away', async () => {
		const { db, statements } = fakeAdminDb()
		const { name, password } = await provisionPreviewDatabase(db, 'job-1234-abcd')

		expect(name).toBe('mf_app_job1234abcd')
		// base64url only: safe inside the quoted literal and the URL
		expect(password).toMatch(/^[A-Za-z0-9_-]+$/)
		expect(statements).toEqual([
			'SELECT 1 FROM pg_roles WHERE rolname = $1',
			`CREATE ROLE ${name} WITH LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE CONNECTION LIMIT 20`,
			`GRANT ${name} TO CURRENT_USER`,
			'SELECT 1 FROM pg_database WHERE datname = $1',
			`CREATE DATABASE ${name} OWNER ${name}`,
			`REVOKE CONNECT ON DATABASE ${name} FROM PUBLIC`,
			`GRANT CONNECT ON DATABASE ${name} TO ${name}`,
		])
	})

	it('re-keys an existing role and keeps an existing database (idempotent redelivery)', async () => {
		const { db, statements } = fakeAdminDb({ role: true, database: true })
		const { name } = await provisionPreviewDatabase(db, 'job-1234-abcd')

		expect(statements.some(text => text.startsWith(`ALTER ROLE ${name} WITH PASSWORD`))).toBe(true)
		// The RDS master user cannot restate role attributes (42501) — the re-key must be password-only
		expect(
			statements
				.filter(text => text.startsWith('ALTER ROLE'))
				.every(text => !/SUPERUSER/.test(text))
		).toBe(true)
		expect(statements.some(text => text.startsWith('CREATE DATABASE'))).toBe(false)
		expect(statements).toContain(`ALTER DATABASE ${name} OWNER TO ${name}`)
	})
})

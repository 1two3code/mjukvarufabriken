import {
	previewDatabaseUrl,
	previewDbName,
	provisionPreviewDatabase,
} from '#/services/previewDbService.ts'

import type { AdminDb } from '#/services/previewDbService.ts'

/** Records every statement; `existing` marks which pg_roles/pg_database lookups find a row */
const fakeAdminDb = (existing: { role?: boolean; database?: boolean } = {}) => {
	const statements: string[] = []
	const db: AdminDb = {
		query: async <T extends Record<string, unknown>>(text: string) => {
			statements.push(text)
			if (text.includes('pg_roles')) return (existing.role ? [{ ok: 1 }] : []) as unknown as T[]
			if (text.includes('pg_database')) return (existing.database ? [{ ok: 1 }] : []) as unknown as T[]
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
			previewDatabaseUrl('postgres://master:secret@db.rds.amazonaws.com:5432/platform', 'mf_app_x', 'pw')
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

		expect(statements.some(text => text.startsWith(`ALTER ROLE ${name} WITH LOGIN PASSWORD`))).toBe(true)
		expect(statements.some(text => text.startsWith('CREATE DATABASE'))).toBe(false)
		expect(statements).toContain(`ALTER DATABASE ${name} OWNER TO ${name}`)
	})
})

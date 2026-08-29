import { readdirSync } from 'node:fs'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createDb, isRdsHost, migrate, migrationsDir } from '#/index.ts'

import type { Db } from '#/index.ts'

/**
 * The rest of the db tests run against the in-memory repositories (`memory.ts`), so nothing
 * else applies the real `migrations/*.sql` against a real Postgres — which is exactly how the
 * wave-10 0016 bug (`deployed_services.order_id uuid` vs `orders.id text`) reached a dev deploy
 * before Postgres rejected the FK at boot-migration time. This suite closes that gap.
 *
 * It is gated on `TEST_DATABASE_URL` (a THROWAWAY database — CI's `postgres` service, or a local
 * `docker compose up postgres` reachable as `postgres://mf:mf@localhost:5432/mf`). `beforeAll`
 * RESETS the target's `public` schema, so it refuses anything that looks like RDS as a guard
 * against ever pointing it at a real dev/live database.
 */
const url = process.env.TEST_DATABASE_URL
const enabled = (() => {
	if (!url) return false
	try {
		return !isRdsHost(new URL(url).hostname)
	} catch {
		return false
	}
})()

describe.skipIf(!enabled)('migrations apply against a real Postgres', () => {
	let db: Db

	beforeAll(async () => {
		db = createDb(url as string, { max: 1 })
		// Fresh database: drop everything a previous run left behind.
		await db.sql.unsafe('drop schema if exists public cascade; create schema public;')
	})

	afterAll(async () => {
		await db?.close()
	})

	it('applies every migration file, in name order, on a fresh database', async () => {
		const files = readdirSync(migrationsDir)
			.filter(file => file.endsWith('.sql'))
			.sort()
		const result = await migrate(db)
		expect(result.applied).toEqual(files)
		expect(result.skipped).toEqual([])
	})

	it('is idempotent — a second run applies nothing and skips them all', async () => {
		const result = await migrate(db)
		expect(result.applied).toEqual([])
		expect(result.skipped.length).toBeGreaterThan(0)
	})

	it('0016 regression: deployed_services.order_id is text with an FK to orders(id)', async () => {
		const [column] = await db.query<{ data_type: string }>(
			`select data_type from information_schema.columns
			 where table_name = 'deployed_services' and column_name = 'order_id'`
		)
		// orders.id is text; a uuid order_id makes Postgres reject the foreign key.
		expect(column?.data_type).toBe('text')

		const fks = await db.query<{ ref_table: string }>(
			`select ccu.table_name as ref_table
			 from information_schema.table_constraints tc
			 join information_schema.constraint_column_usage ccu
			   on ccu.constraint_name = tc.constraint_name
			 where tc.constraint_type = 'FOREIGN KEY' and tc.table_name = 'deployed_services'`
		)
		const refs = fks.map(row => row.ref_table)
		expect(refs).toContain('orders')
		expect(refs).toContain('jobs')
	})
})

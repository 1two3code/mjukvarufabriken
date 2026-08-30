import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Db } from './index.ts'

export const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')

export type MigrationResult = { applied: string[]; skipped: string[] }

/** Arbitrary constant: every runner takes the same advisory lock, so migrations serialise */
export const migrationLockKey = 727_001

/**
 * Applies every `migrations/*.sql` file in name order, tracked in `schema_migrations`. The whole
 * read-and-apply loop runs in one transaction holding a transaction-level advisory lock, so
 * concurrent runners (two api tasks, an api and a job task) serialise and the second one sees
 * the files as already applied. Re-running is a no-op for already-applied files.
 */
export const migrate = async (db: Db, dir = migrationsDir): Promise<MigrationResult> => {
	const { sql } = db
	const files = (await readdir(dir)).filter(file => file.endsWith('.sql')).sort()
	const result: MigrationResult = { applied: [], skipped: [] }

	await sql.begin(async tx => {
		await tx`select pg_advisory_xact_lock(${migrationLockKey})`
		await tx`create table if not exists schema_migrations (
			name text primary key,
			applied_at timestamptz not null default now()
		)`
		const done = new Set(
			(await tx<{ name: string }[]>`select name from schema_migrations`).map(row => row.name)
		)
		for (const file of files) {
			if (done.has(file)) {
				result.skipped.push(file)
				continue
			}
			const text = await readFile(join(dir, file), 'utf8')
			await tx.unsafe(text)
			await tx`insert into schema_migrations (name) values (${file})`
			result.applied.push(file)
		}
	})
	return result
}

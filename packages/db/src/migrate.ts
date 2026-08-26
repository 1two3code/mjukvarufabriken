import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Db } from './index.ts'

export const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')

export type MigrationResult = { applied: string[]; skipped: string[] }

/**
 * Applies every `migrations/*.sql` file in name order inside one transaction each, tracked in
 * `schema_migrations`. Re-running is a no-op for already-applied files.
 */
export const migrate = async (db: Db, dir = migrationsDir): Promise<MigrationResult> => {
	const { sql } = db
	await sql`create table if not exists schema_migrations (
		name text primary key,
		applied_at timestamptz not null default now()
	)`

	const files = (await readdir(dir)).filter(file => file.endsWith('.sql')).sort()
	const done = new Set(
		(await sql<{ name: string }[]>`select name from schema_migrations`).map(row => row.name)
	)

	const result: MigrationResult = { applied: [], skipped: [] }
	for (const file of files) {
		if (done.has(file)) {
			result.skipped.push(file)
			continue
		}
		const text = await readFile(join(dir, file), 'utf8')
		await sql.begin(async tx => {
			await tx.unsafe(text)
			await tx`insert into schema_migrations (name) values (${file})`
		})
		result.applied.push(file)
	}
	return result
}

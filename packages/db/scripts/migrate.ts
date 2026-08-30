/**
 * Applies pending migrations against `DATABASE_URL`.
 * Run from the repo root: `npm run db:migrate` (loads root .env if present).
 */
import { createDb, migrate } from '#/index.ts'

const url = process.env.DATABASE_URL
if (!url) {
	console.error('DATABASE_URL is not set (see packages/db/README.md)')
	process.exit(1)
}

const db = createDb(url, { max: 1 })
try {
	const result = await migrate(db)
	console.log(`applied: ${result.applied.join(', ') || '-'}`)
	console.log(`skipped: ${result.skipped.join(', ') || '-'}`)
} finally {
	await db.close()
}

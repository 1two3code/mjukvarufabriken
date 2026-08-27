import type { Db } from './index.ts'
import type { RateLimitsRepository } from './repositories.ts'

/**
 * Retention for the housekeeping prune: hits older than this count for nothing (longer than any
 * window a service counts over — the contact form's is 10 min), so dropping them never changes a
 * verdict. Kept generous so a new, longer window does not silently start losing hits.
 *
 * Single source of truth: the memory backend re-exports this as `memoryRateLimitRetentionMs`, so the
 * Postgres pruner and the in-memory sweep can never drift apart.
 */
export const rateLimitRetentionMs = 60 * 60 * 1000

/**
 * SECURITY INVARIANT, enforced in code rather than by comment: a limiter must never count over a
 * window longer than {@link rateLimitRetentionMs}. Past that horizon the pruner (and the memory
 * sweep) have already dropped hits, so the count would silently under-report and a caller could slip
 * past the ceiling. Compute a limiter's lower bound (`since`) with this helper — it returns
 * `now - windowMs` but throws first if the window would outrun retention, turning a new, longer
 * window into a loud boot/test failure instead of a quiet bypass.
 */
export const rateLimitWindowStart = (windowMs: number, now: Date = new Date()): Date => {
	if (windowMs > rateLimitRetentionMs) {
		throw new Error(
			`rate-limit window (${windowMs}ms) exceeds retention (${rateLimitRetentionMs}ms): ` +
				'raise rateLimitRetentionMs or shorten the window — pruned hits would bypass the limit'
		)
	}
	return new Date(now.getTime() - windowMs)
}

// MARK: Rate limits (one row per counted hit)

export const countRateLimitHits = async (
	db: Db,
	scope: string,
	key: string | undefined,
	since: Date
): Promise<number> => {
	const [row] = await db.sql<{ count: number }[]>`
		select count(*)::int as count from rate_limits
		where scope = ${scope}
		${key === undefined ? db.sql`` : db.sql`and key = ${key}`}
		and hit_at > ${since}`
	return Number(row?.count ?? 0)
}

export const recordRateLimitHit = async (
	db: Db,
	scope: string,
	key: string,
	at: Date
): Promise<void> => {
	await db.sql`insert into rate_limits (scope, key, hit_at) values (${scope}, ${key}, ${at})`
}

/**
 * Housekeeping: drops hits older than `before` (nothing counts them any more). Returns the number
 * of rows deleted so the caller can log a summary.
 */
export const pruneRateLimits = async (db: Db, before: Date): Promise<number> => {
	const deleted = await db.sql`delete from rate_limits where hit_at < ${before}`
	return deleted.count
}

export const createRateLimitsRepository = (db: Db): RateLimitsRepository => ({
	count: (scope, key, since) => countRateLimitHits(db, scope, key, since),
	record: (scope, key, at = new Date()) => recordRateLimitHit(db, scope, key, at),
	pruneExpired: () => pruneRateLimits(db, new Date(Date.now() - rateLimitRetentionMs)),
})

import type { Db } from './index.ts'
import type { RateLimitsRepository } from './repositories.ts'

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

/** Housekeeping: drops hits older than `before` (nothing counts them any more) */
export const pruneRateLimits = async (db: Db, before: Date): Promise<void> => {
	await db.sql`delete from rate_limits where hit_at < ${before}`
}

export const createRateLimitsRepository = (db: Db): RateLimitsRepository => ({
	count: (scope, key, since) => countRateLimitHits(db, scope, key, since),
	record: (scope, key, at = new Date()) => recordRateLimitHit(db, scope, key, at),
	prune: before => pruneRateLimits(db, before),
})

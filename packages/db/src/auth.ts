import { isUuid } from './jobs.ts'

import type { Db } from './index.ts'
import type { AuthRepository, MagicLink, RefreshToken } from './repositories.ts'

// MARK: Row mapping

type MagicLinkRow = {
	token_hash: string
	email: string
	expires_at: Date
	used_at: Date | null
	created_at: Date
}

type RefreshTokenRow = {
	token_hash: string
	user_id: string
	expires_at: Date
	revoked_at: Date | null
	created_at: Date
}

export const toMagicLink = (row: MagicLinkRow): MagicLink => ({
	tokenHash: row.token_hash,
	email: row.email,
	createdAt: row.created_at.toISOString(),
	expiresAt: row.expires_at.toISOString(),
	usedAt: row.used_at?.toISOString(),
})

export const toRefreshToken = (row: RefreshTokenRow): RefreshToken => ({
	tokenHash: row.token_hash,
	userId: row.user_id,
	createdAt: row.created_at.toISOString(),
	expiresAt: row.expires_at.toISOString(),
	revokedAt: row.revoked_at?.toISOString(),
})

// MARK: Magic links

export const insertMagicLink = async (
	db: Db,
	link: { tokenHash: string; email: string; expiresAt: Date }
): Promise<MagicLink> => {
	const [row] = await db.sql<MagicLinkRow[]>`
		insert into magic_links (token_hash, email, expires_at)
		values (${link.tokenHash}, ${link.email}, ${link.expiresAt})
		returning *`
	return toMagicLink(row!)
}

export const getMagicLink = async (db: Db, tokenHash: string): Promise<MagicLink | undefined> => {
	const [row] = await db.sql<MagicLinkRow[]>`
		select * from magic_links where token_hash = ${tokenHash}`
	return row && toMagicLink(row)
}

/** Atomic single use: the update only matches an unused link */
export const consumeMagicLink = async (
	db: Db,
	tokenHash: string
): Promise<MagicLink | undefined> => {
	const [row] = await db.sql<MagicLinkRow[]>`
		update magic_links set used_at = now()
		where token_hash = ${tokenHash} and used_at is null
		returning *`
	return row && toMagicLink(row)
}

export const countMagicLinksSince = async (db: Db, email: string, since: Date) => {
	const [row] = await db.sql<{ count: number }[]>`
		select count(*)::int as count from magic_links
		where email = ${email} and created_at > ${since}`
	return Number(row?.count ?? 0)
}

// MARK: Refresh tokens

export const insertRefreshToken = async (
	db: Db,
	token: { tokenHash: string; userId: string; expiresAt: Date }
): Promise<RefreshToken> => {
	const [row] = await db.sql<RefreshTokenRow[]>`
		insert into refresh_tokens (token_hash, user_id, expires_at)
		values (${token.tokenHash}, ${token.userId}, ${token.expiresAt})
		returning *`
	return toRefreshToken(row!)
}

/** Rotation: revokes the token and returns it; already revoked or unknown → `undefined` */
export const consumeRefreshToken = async (
	db: Db,
	tokenHash: string
): Promise<RefreshToken | undefined> => {
	const [row] = await db.sql<RefreshTokenRow[]>`
		update refresh_tokens set revoked_at = now()
		where token_hash = ${tokenHash} and revoked_at is null
		returning *`
	return row && toRefreshToken(row)
}

export const revokeRefreshToken = async (db: Db, tokenHash: string): Promise<void> => {
	await db.sql`
		update refresh_tokens set revoked_at = now()
		where token_hash = ${tokenHash} and revoked_at is null`
}

/** Housekeeping: drops expired links and revoked/expired tokens older than a week */
export const pruneAuth = async (db: Db): Promise<void> => {
	await db.sql`delete from magic_links where expires_at < now() - interval '7 days'`
	await db.sql`
		delete from refresh_tokens
		where expires_at < now() or revoked_at < now() - interval '7 days'`
}

export const createAuthRepository = (db: Db): AuthRepository => ({
	insertMagicLink: link => insertMagicLink(db, link),
	getMagicLink: tokenHash => getMagicLink(db, tokenHash),
	consumeMagicLink: tokenHash => consumeMagicLink(db, tokenHash),
	countMagicLinksSince: (email, since) => countMagicLinksSince(db, email, since),
	insertRefreshToken: token =>
		isUuid(token.userId)
			? insertRefreshToken(db, token)
			: Promise.reject(new Error(`refresh token: user id "${token.userId}" is not a uuid`)),
	consumeRefreshToken: tokenHash => consumeRefreshToken(db, tokenHash),
	revokeRefreshToken: tokenHash => revokeRefreshToken(db, tokenHash),
	prune: () => pruneAuth(db),
})

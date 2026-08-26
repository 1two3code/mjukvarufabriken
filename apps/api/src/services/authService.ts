import fp from 'fastify-plugin'
import { SignJWT } from 'jose'

import { EntityInvalid } from '#/lib/entityError.ts'
import { scheduleHousekeeping } from '#/lib/housekeeping.ts'
import { authAlgorithm } from '#/plugins/authKeys.utils.ts'
import {
	addDays,
	addMinutes,
	buildMagicLink,
	generateToken,
	hashToken,
	isExpired,
	magicLinkEmail,
} from '#/services/authService.utils.ts'
import { normalizeEmail } from '#/services/userService.utils.ts'

import type { FastifyPluginAsync } from 'fastify'
import type { TokenPair, User } from '@mf/models'

declare module 'fastify' {
	interface FastifyInstance {
		authService: {
			/**
			 * Emails a single-use magic link (15 min). Silently does nothing when the address has
			 * asked for more than `magicLinkRateLimit.max` links in the last window — callers must
			 * never reveal whether anything was sent.
			 */
			requestMagicLink: (email: string) => Promise<void>
			/** Consumes a magic link and signs the user in. Throws EntityInvalid when unknown/expired/used. */
			verifyMagicLink: (token: string) => Promise<TokenPair>
			/** Rotates a refresh token. Throws EntityInvalid when unknown/expired. */
			refresh: (refreshToken: string) => Promise<TokenPair>
			/** Revokes a refresh token. Unknown tokens are ignored. */
			logout: (refreshToken: string) => Promise<void>
		}
	}
}

export const magicLinkTtlMinutes = 15
export const magicLinkRateLimit = { max: 3, windowMinutes: 10 } as const
export const accessTokenTtl = '1h'
export const refreshTokenTtlDays = 30

const plugin: FastifyPluginAsync = async app => {
	const { db, secrets, authKeys, email: mailer, userService } = app

	const countRecentLinks = (email: string, now: Date) =>
		db.auth.countMagicLinksSince(email, addMinutes(now, -magicLinkRateLimit.windowMinutes))

	const signAccessToken = (user: User) =>
		new SignJWT({ email: user.email, name: user.name, role: user.role, orgId: user.orgId })
			.setProtectedHeader({ alg: authAlgorithm, kid: authKeys.kid })
			.setSubject(user.id)
			.setIssuer(secrets.authIssuer)
			.setAudience(secrets.authAudience)
			.setIssuedAt()
			.setExpirationTime(accessTokenTtl)
			.sign(authKeys.privateKey)

	const issueTokenPair = async (user: User): Promise<TokenPair> => {
		const now = new Date()
		const refreshToken = generateToken()
		await db.auth.insertRefreshToken({
			tokenHash: hashToken(refreshToken),
			userId: user.id,
			expiresAt: addDays(now, refreshTokenTtlDays),
		})
		return { token: await signAccessToken(user), refreshToken }
	}

	// Housekeeping: nothing else deletes magic_links / refresh_tokens rows (every request and
	// every refresh inserts one). Shortly after boot, then hourly with jitter, Postgres only — the
	// memory repository sweeps itself on insert.
	scheduleHousekeeping(app, 'Auth prune', () => db.auth.prune())

	app.decorate('authService', {
		requestMagicLink: async rawEmail => {
			const email = normalizeEmail(rawEmail)
			const now = new Date()

			if ((await countRecentLinks(email, now)) >= magicLinkRateLimit.max) {
				app.log.warn({ email }, 'Magic link rate limit hit')
				return
			}

			const token = generateToken()
			await db.auth.insertMagicLink({
				tokenHash: hashToken(token),
				email,
				expiresAt: addMinutes(now, magicLinkTtlMinutes),
			})

			const url = buildMagicLink(secrets.portalUrl, token)
			await mailer.send({ to: email, ...magicLinkEmail(url, secrets.portalUrl) })
		},

		verifyMagicLink: async token => {
			// Consuming is atomic (unknown/used → undefined); an expired link is consumed too
			const link = await db.auth.consumeMagicLink(hashToken(token))
			if (!link || isExpired(link.expiresAt)) throw new EntityInvalid('magicLink')

			const user = await userService.findOrCreateByEmail(link.email)
			return issueTokenPair(user)
		},

		refresh: async refreshToken => {
			// Rotation: the presented token is revoked whether or not it is still valid
			const stored = await db.auth.consumeRefreshToken(hashToken(refreshToken))
			if (!stored || isExpired(stored.expiresAt)) throw new EntityInvalid('refreshToken')

			const user = await userService.get(stored.userId)
			return issueTokenPair(user)
		},

		logout: async refreshToken => {
			await db.auth.revokeRefreshToken(hashToken(refreshToken))
		},
	})
}

export default fp(plugin, {
	name: '#internal/authService',
	dependencies: [
		'#internal/db',
		'#internal/secrets',
		'#internal/authKeys',
		'#internal/email',
		'#internal/userService',
	],
})

import fp from 'fastify-plugin'
import { SignJWT } from 'jose'

import { EntityInvalid } from '#/lib/entityError.ts'
import { authAlgorithm } from '#/plugins/authKeys.utils.ts'
import { storeCollections } from '#/plugins/store.ts'
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

/** Stored per magic link, keyed by the sha256 of the token */
export type StoredMagicLink = {
	email: string
	createdAt: string
	expiresAt: string
	usedAt?: string
}

/** Stored per refresh token, keyed by the sha256 of the token */
export type StoredRefreshToken = {
	userId: string
	createdAt: string
	expiresAt: string
}

const plugin: FastifyPluginAsync = async app => {
	const { store, secrets, authKeys, email: mailer, userService } = app

	const countRecentLinks = async (email: string, now: Date) => {
		const since = addMinutes(now, -magicLinkRateLimit.windowMinutes)
		const links = await store.list<StoredMagicLink>(storeCollections.magicLinks)
		return links.filter(link => link.email === email && new Date(link.createdAt) > since).length
	}

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
		const stored: StoredRefreshToken = {
			userId: user.id,
			createdAt: now.toISOString(),
			expiresAt: addDays(now, refreshTokenTtlDays).toISOString(),
		}
		await store.put(storeCollections.refreshTokens, hashToken(refreshToken), stored)
		return { token: await signAccessToken(user), refreshToken }
	}

	app.decorate('authService', {
		requestMagicLink: async rawEmail => {
			const email = normalizeEmail(rawEmail)
			const now = new Date()

			if ((await countRecentLinks(email, now)) >= magicLinkRateLimit.max) {
				app.log.warn({ email }, 'Magic link rate limit hit')
				return
			}

			const token = generateToken()
			const link: StoredMagicLink = {
				email,
				createdAt: now.toISOString(),
				expiresAt: addMinutes(now, magicLinkTtlMinutes).toISOString(),
			}
			await store.put(storeCollections.magicLinks, hashToken(token), link)

			const url = buildMagicLink(secrets.portalUrl, token)
			await mailer.send({ to: email, ...magicLinkEmail(url, secrets.portalUrl) })
		},

		verifyMagicLink: async token => {
			const hash = hashToken(token)
			const link = await store.get<StoredMagicLink>(storeCollections.magicLinks, hash)
			if (!link || link.usedAt || isExpired(link.expiresAt)) {
				throw new EntityInvalid('magicLink')
			}
			await store.put(storeCollections.magicLinks, hash, {
				...link,
				usedAt: new Date().toISOString(),
			})

			const user = await userService.findOrCreateByEmail(link.email)
			return issueTokenPair(user)
		},

		refresh: async refreshToken => {
			const hash = hashToken(refreshToken)
			const stored = await store.get<StoredRefreshToken>(storeCollections.refreshTokens, hash)
			// Rotation: the presented token is consumed whether or not it is still valid
			await store.delete(storeCollections.refreshTokens, hash)
			if (!stored || isExpired(stored.expiresAt)) throw new EntityInvalid('refreshToken')

			const user = await userService.get(stored.userId)
			return issueTokenPair(user)
		},

		logout: async refreshToken => {
			await store.delete(storeCollections.refreshTokens, hashToken(refreshToken))
		},
	})
}

export default fp(plugin, {
	name: '#internal/authService',
	dependencies: [
		'#internal/store',
		'#internal/secrets',
		'#internal/authKeys',
		'#internal/email',
		'#internal/userService',
	],
})

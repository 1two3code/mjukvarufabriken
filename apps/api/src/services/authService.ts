import fp from 'fastify-plugin'
import { SignJWT } from 'jose'

import { EntityInvalid } from '#/lib/entityError.ts'
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
import type { GithubProfile } from '#/plugins/githubOAuth.ts'

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
			/**
			 * Signs a GitHub account in (M6): the user already linked to the account, else the user
			 * with the same verified email (linked now — replacing an earlier link, since GitHub
			 * verifies an address on one account at a time), else a new user + org with the
			 * magic-link rules. Throws EntityInvalid('githubEmail') when GitHub has no verified
			 * email for it.
			 */
			signInWithGithub: (profile: GithubProfile) => Promise<User>
			/**
			 * One-shot portal link (`/auth/callback?token=…`, 2 min) for a user just authenticated
			 * by another provider. Consumed by `verifyMagicLink` exactly like an emailed link, so
			 * the token pair never travels in a redirect url. Stored with purpose `login`, so it
			 * never counts against the address's emailed-link rate limit.
			 */
			createLoginLink: (user: User) => Promise<string>
		}
	}
}

export const magicLinkTtlMinutes = 15
export const magicLinkRateLimit = { max: 3, windowMinutes: 10 } as const
/** A GitHub sign-in ends in a one-shot link the browser follows at once */
export const loginLinkTtlMinutes = 2
export const accessTokenTtl = '1h'
export const refreshTokenTtlDays = 30
/** Expired links and rotated tokens are pruned at boot and then hourly */
export const pruneIntervalMs = 60 * 60 * 1000

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
	// every refresh inserts one). Failures are logged, never fatal.
	const prune = () =>
		db.auth.prune().catch((error: Error) => app.log.warn({ err: error }, 'Auth prune failed'))
	if (db.available) {
		await prune()
		const timer = setInterval(prune, pruneIntervalMs)
		timer.unref()
		app.addHook('onClose', () => clearInterval(timer))
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

		signInWithGithub: async profile => {
			const identity = { githubId: profile.id, githubLogin: profile.login, name: profile.name }
			const linked = await db.users.findByGithubId(profile.id)
			if (linked) {
				// Same account: refresh the login (renames) and fill in a missing name
				if (linked.githubLogin === profile.login && (linked.name || !profile.name)) return linked
				return (await db.users.linkGithub(linked.id, identity)) ?? linked
			}
			if (!profile.email) throw new EntityInvalid('githubEmail', profile.login)

			const user = await userService.findOrCreateByEmail(profile.email)
			if (user.githubId) {
				// The verified email moved to another GitHub account (the old one deleted or
				// re-created): the user follows their email — allowed, but worth a trace
				app.log.warn(
					{ userId: user.id, from: user.githubLogin, to: profile.login },
					'GitHub sign-in re-links the user to another GitHub account'
				)
			}
			return (await db.users.linkGithub(user.id, identity)) ?? user
		},

		createLoginLink: async user => {
			const token = generateToken()
			await db.auth.insertMagicLink({
				tokenHash: hashToken(token),
				email: user.email,
				expiresAt: addMinutes(new Date(), loginLinkTtlMinutes),
				purpose: 'login',
			})
			return buildMagicLink(secrets.portalUrl, token)
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

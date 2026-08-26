import { decodeProtectedHeader, jwtVerify } from 'jose'

import { EntityInvalid } from '#/lib/entityError.ts'
import { createMockUser } from '#/services/__mocks__/userService.ts'
import { magicLinkRateLimit, magicLinkTtlMinutes, pruneIntervalMs } from '#/services/authService.ts'
import { hashToken } from '#/services/authService.utils.ts'

import type { FastifyInstance } from 'fastify'
import type { OutgoingEmail } from '#/plugins/email.ts'

const email = 'anna@acme.se'

describe('Auth Service', () => {
	let app: FastifyInstance

	/** Requests a link for `email` and returns the token from the mocked mailer */
	const requestToken = async (to = email) => {
		await app.authService.requestMagicLink(to)
		const sent = vi.mocked(app.email.send).mock.calls.at(-1)?.[0] as OutgoingEmail
		return new URL(sent.text.match(/https?:\/\/\S+/)![0]).searchParams.get('token')!
	}

	beforeEach(async () => {
		app = await createTestApp({ skipMock: '#/services/authService.ts' })
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	describe('housekeeping', () => {
		it('Prunes expired links and tokens at boot and then on an interval', async () => {
			// Arrange
			vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
			app = await createTestApp({ skipMock: '#/services/authService.ts' })
			const prune = vi.spyOn(app.db.auth, 'prune')
			await app.db.auth.insertMagicLink({
				tokenHash: 'stale',
				email,
				expiresAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
			})

			// Act
			await vi.advanceTimersByTimeAsync(pruneIntervalMs)

			// Assert
			expect(prune).toHaveBeenCalledTimes(1)
			await expect(app.db.auth.getMagicLink('stale')).resolves.toBeUndefined()
		})
	})

	describe('requestMagicLink', () => {
		it('Stores only the hash of the token with a 15 minute expiry and emails the link', async () => {
			// Arrange
			vi.useFakeTimers({ toFake: ['Date'] })
			vi.setSystemTime(new Date('2026-08-26T10:00:00.000Z'))

			// Act
			const token = await requestToken('Anna@Acme.se')

			// Assert
			expect(app.email.send).toHaveBeenCalledWith(
				expect.objectContaining({
					to: email,
					text: expect.stringContaining(`${app.secrets.portalUrl}/auth/callback?token=${token}`),
				})
			)
			await expect(app.db.auth.getMagicLink(token)).resolves.toBeUndefined()
			await expect(app.db.auth.getMagicLink(hashToken(token))).resolves.toEqual({
				tokenHash: hashToken(token),
				email,
				createdAt: '2026-08-26T10:00:00.000Z',
				expiresAt: `2026-08-26T10:${magicLinkTtlMinutes}:00.000Z`,
			})
		})

		it('Stops sending after the rate limit within the window and resumes after it', async () => {
			// Arrange
			vi.useFakeTimers({ toFake: ['Date'] })
			vi.setSystemTime(new Date('2026-08-26T10:00:00.000Z'))

			// Act
			for (let i = 0; i <= magicLinkRateLimit.max; i++) {
				await app.authService.requestMagicLink(email)
			}
			await app.authService.requestMagicLink('other@acme.se')
			const sentWithinWindow = vi.mocked(app.email.send).mock.calls.length

			vi.setSystemTime(new Date('2026-08-26T10:11:00.000Z'))
			await app.authService.requestMagicLink(email)

			// Assert — 3 for anna, 1 for other, then 1 more for anna after the window
			expect(sentWithinWindow).toBe(magicLinkRateLimit.max + 1)
			expect(app.email.send).toHaveBeenCalledTimes(magicLinkRateLimit.max + 2)
		})
	})

	describe('verifyMagicLink', () => {
		it('Issues an EdDSA access token with user claims and an opaque refresh token', async () => {
			// Arrange
			const user = createMockUser({ email, role: 'admin' })
			vi.spyOn(app.userService, 'findOrCreateByEmail').mockResolvedValue(user)
			const token = await requestToken()

			// Act
			const pair = await app.authService.verifyMagicLink(token)

			// Assert
			expect(app.userService.findOrCreateByEmail).toHaveBeenCalledWith(email)
			expect(decodeProtectedHeader(pair.token)).toEqual({ alg: 'EdDSA', kid: app.authKeys.kid })
			const { payload } = await jwtVerify(pair.token, app.authKeys.publicKey, {
				issuer: app.secrets.authIssuer,
				audience: app.secrets.authAudience,
			})
			expect(payload).toMatchObject({
				sub: user.id,
				email: user.email,
				name: user.name,
				role: 'admin',
				orgId: user.orgId,
			})
			expect(payload.exp! - payload.iat!).toBe(60 * 60)
			expect(pair.refreshToken).toMatch(/^[A-Za-z0-9_-]{40,}$/)
			await expect(app.db.auth.consumeRefreshToken(hashToken(pair.refreshToken))).resolves.toEqual({
				tokenHash: hashToken(pair.refreshToken),
				userId: user.id,
				createdAt: expect.any(String),
				expiresAt: expect.any(String),
				revokedAt: expect.any(String),
			})
		})

		it('Is single use', async () => {
			// Arrange
			const token = await requestToken()
			await app.authService.verifyMagicLink(token)

			// Act & Assert
			await expect(app.authService.verifyMagicLink(token)).rejects.toBeInstanceOf(EntityInvalid)
		})

		it('Rejects an expired link', async () => {
			// Arrange
			vi.useFakeTimers({ toFake: ['Date'] })
			vi.setSystemTime(new Date('2026-08-26T10:00:00.000Z'))
			const token = await requestToken()
			vi.setSystemTime(new Date('2026-08-26T10:15:00.001Z'))

			// Act & Assert
			await expect(app.authService.verifyMagicLink(token)).rejects.toBeInstanceOf(EntityInvalid)
		})

		it('Rejects an unknown token', async () => {
			await expect(app.authService.verifyMagicLink('nope')).rejects.toBeInstanceOf(EntityInvalid)
		})
	})

	describe('refresh', () => {
		it('Rotates the refresh token and invalidates the previous one', async () => {
			// Arrange
			const pair = await app.authService.verifyMagicLink(await requestToken())

			// Act
			const rotated = await app.authService.refresh(pair.refreshToken)

			// Assert
			expect(rotated.refreshToken).not.toBe(pair.refreshToken)
			expect(rotated.token).toEqual(expect.any(String))
			await expect(app.authService.refresh(pair.refreshToken)).rejects.toBeInstanceOf(EntityInvalid)
			await expect(app.authService.refresh(rotated.refreshToken)).resolves.toBeDefined()
		})

		it('Rejects an expired refresh token', async () => {
			// Arrange
			vi.useFakeTimers({ toFake: ['Date'] })
			vi.setSystemTime(new Date('2026-08-26T10:00:00.000Z'))
			const pair = await app.authService.verifyMagicLink(await requestToken())
			vi.setSystemTime(new Date('2026-09-26T10:00:00.000Z'))

			// Act & Assert
			await expect(app.authService.refresh(pair.refreshToken)).rejects.toBeInstanceOf(EntityInvalid)
		})
	})

	describe('logout', () => {
		it('Revokes the refresh token and ignores unknown ones', async () => {
			// Arrange
			const pair = await app.authService.verifyMagicLink(await requestToken())

			// Act
			await app.authService.logout(pair.refreshToken)
			await app.authService.logout('unknown')

			// Assert
			await expect(app.authService.refresh(pair.refreshToken)).rejects.toBeInstanceOf(EntityInvalid)
		})
	})
})

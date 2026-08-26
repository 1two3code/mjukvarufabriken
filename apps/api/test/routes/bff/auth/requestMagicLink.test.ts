import { decodeJwt } from 'jose'

import requestMagicLink from '#/routes/bff/auth/requestMagicLink.ts'

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import type { MockInstance } from 'vitest'

const url = '/bff/auth/magic-link'

describe('POST /bff/auth/magic-link route', () => {
	let app: FastifyInstance

	beforeEach(async () => {
		app = await createTestApp()
		app.register(requestMagicLink)
	})

	it('Answers 202 with an empty body and asks the service for a link', async () => {
		// Act
		const response = await app.inject({ method: 'POST', url, payload: { email: 'a@b.se' } })

		// Assert
		expect(response.statusCode).toBe(202)
		expect(response.json()).toEqual({})
		expect(app.authService.requestMagicLink).toHaveBeenCalledWith('a@b.se')
	})

	it('Still answers 202 when sending fails (never reveals anything)', async () => {
		// Arrange
		vi.spyOn(app.authService, 'requestMagicLink').mockRejectedValueOnce(new Error('SES down'))

		// Act
		const response = await app.inject({ method: 'POST', url, payload: { email: 'a@b.se' } })

		// Assert
		expect(response.statusCode).toBe(202)
	})

	it('Rejects an invalid email with 400', async () => {
		// Act
		const response = await app.inject({ method: 'POST', url, payload: { email: 'nope' } })

		// Assert
		expect(response.statusCode).toBe(400)
		expect(app.authService.requestMagicLink).not.toHaveBeenCalled()
	})
})

describe('Magic-link flow end to end (real services, log transport)', () => {
	let app: FastifyInstance
	let info: MockInstance<FastifyInstance['log']['info']>

	/** Pulls the magic link out of the logged email and returns its token */
	const captureToken = () => {
		const logged = info.mock.calls
			.map(([payload]) => (payload as { email?: { text: string } } | undefined)?.email?.text)
			.filter((text): text is string => typeof text === 'string')
		const link = logged.at(-1)?.match(/https?:\/\/\S+/)?.[0]
		if (!link) throw new Error('No magic link was logged')
		return new URL(link).searchParams.get('token')!
	}

	const realModules = [
		'#/services/authService.ts',
		'#/services/userService.ts',
		'#/plugins/store.ts',
		'#/plugins/email.ts',
	]

	beforeEach(async () => {
		// The mocked suite above registered these with vi.doMock — undo before going real
		realModules.forEach(module => vi.doUnmock(module))
		vi.resetModules()
		app = await createTestApp({ skipMock: realModules })
		// Import after the reset so routes and services share one module graph (error classes)
		for (const path of [
			'#/routes/bff/auth/requestMagicLink.ts',
			'#/routes/bff/auth/verifyMagicLink.ts',
			'#/routes/bff/auth/refresh.ts',
			'#/routes/bff/auth/logout.ts',
		]) {
			const route = (await import(path)) as { default: FastifyPluginAsync }
			app.register(route.default)
		}
		info = vi.spyOn(app.log, 'info')
	})

	it('Requests a link, verifies it, refreshes and logs out', async () => {
		// Act — request
		const requested = await app.inject({
			method: 'POST',
			url,
			payload: { email: 'Anna@Acme.se' },
		})
		const token = captureToken()

		// Assert — link points at the portal callback
		expect(requested.statusCode).toBe(202)
		expect(info).toHaveBeenCalledWith(
			expect.objectContaining({
				email: expect.objectContaining({
					to: 'anna@acme.se',
					text: expect.stringContaining(`${app.secrets.portalUrl}/auth/callback?token=`),
				}),
			}),
			expect.any(String)
		)

		// Act — verify
		const verified = await app.inject({
			method: 'POST',
			url: '/bff/auth/verify',
			payload: { token },
		})
		const pair = verified.json()

		// Assert — access token carries the new user + org
		expect(verified.statusCode).toBe(200)
		expect(pair).toEqual({ token: expect.any(String), refreshToken: expect.any(String) })
		const claims = decodeJwt(pair.token)
		const user = await app.userService.findByEmail('anna@acme.se')
		const org = await app.userService.getOrg(user!.orgId)
		expect(claims).toMatchObject({
			sub: user!.id,
			email: 'anna@acme.se',
			role: 'user',
			orgId: org.id,
			iss: app.secrets.authIssuer,
			aud: app.secrets.authAudience,
		})
		expect(org.name).toBe('acme.se')

		// Act — the link is single use
		const reused = await app.inject({
			method: 'POST',
			url: '/bff/auth/verify',
			payload: { token },
		})
		expect(reused.statusCode).toBe(401)
		expect(reused.json().error.code).toBe('invalidMagicLink')

		// Act — refresh rotates
		const refreshed = await app.inject({
			method: 'POST',
			url: '/bff/auth/refresh',
			payload: { refreshToken: pair.refreshToken },
		})
		expect(refreshed.statusCode).toBe(200)
		const rotated = refreshed.json()
		expect(rotated.refreshToken).not.toBe(pair.refreshToken)

		const replayed = await app.inject({
			method: 'POST',
			url: '/bff/auth/refresh',
			payload: { refreshToken: pair.refreshToken },
		})
		expect(replayed.statusCode).toBe(401)

		// Act — logout revokes the current refresh token
		const loggedOut = await app.inject({
			method: 'POST',
			url: '/bff/auth/logout',
			payload: { refreshToken: rotated.refreshToken },
		})
		expect(loggedOut.statusCode).toBe(204)
		const afterLogout = await app.inject({
			method: 'POST',
			url: '/bff/auth/refresh',
			payload: { refreshToken: rotated.refreshToken },
		})
		expect(afterLogout.statusCode).toBe(401)
	})

	it('Signs in an admin email with the admin role and reuses the user on the next login', async () => {
		// Arrange
		const email = app.secrets.authAdminEmails[0]!
		const signIn = async () => {
			await app.inject({ method: 'POST', url, payload: { email } })
			const token = captureToken()
			const response = await app.inject({
				method: 'POST',
				url: '/bff/auth/verify',
				payload: { token },
			})
			return decodeJwt(response.json().token)
		}

		// Act
		const first = await signIn()
		const second = await signIn()

		// Assert
		expect(first.role).toBe('admin')
		expect(second.sub).toBe(first.sub)
		expect(second.orgId).toBe(first.orgId)
	})
})

import { EntityInvalid } from '#/lib/entityError.ts'
import { createMockGithubProfile } from '#/plugins/__mocks__/githubOAuth.ts'
import { unconfiguredClient } from '#/plugins/githubOAuth.ts'
import { stateCookieName } from '#/routes/bff/auth/github.utils.ts'
import githubCallback from '#/routes/bff/auth/githubCallback.ts'
import { createMockUser } from '#/services/__mocks__/userService.ts'

import type { FastifyInstance } from 'fastify'

const state = 'state-123'
const url = `/bff/auth/github/callback?code=abc&state=${state}`
const cookie = `${stateCookieName}=${state}`
const portalCallback = 'https://portal.example.com/auth/github/callback'

describe('GET /bff/auth/github/callback route', () => {
	let app: FastifyInstance

	beforeEach(async () => {
		app = await createTestApp()
		app.register(githubCallback)
	})

	it('Exchanges the code, signs the user in and redirects to a one-shot login link', async () => {
		// Arrange
		const profile = createMockGithubProfile()
		const user = createMockUser({ githubId: profile.id, githubLogin: profile.login })
		vi.spyOn(app.authService, 'signInWithGithub').mockResolvedValue(user)

		// Act
		const response = await app.inject({ url, headers: { cookie } })

		// Assert
		expect(response.statusCode).toBe(302)
		expect(response.headers.location).toBe(
			'https://portal.example.com/auth/callback?token=login-token'
		)
		expect(app.githubOauth.fetchProfile).toHaveBeenCalledWith({
			code: 'abc',
			redirectUri: portalCallback,
		})
		expect(app.authService.signInWithGithub).toHaveBeenCalledWith(profile)
		expect(app.authService.createLoginLink).toHaveBeenCalledWith(user)
		// The state cookie is single use
		expect(response.headers['set-cookie']).toContain(`${stateCookieName}=; Max-Age=0`)
	})

	it('Rejects a state that does not match the cookie without touching GitHub', async () => {
		// Act
		const mismatch = await app.inject({ url, headers: { cookie: `${stateCookieName}=other` } })
		const missing = await app.inject({ url })
		// Same character count as the cookie but more bytes: must be a redirect, never a 500
		const multibyte = await app.inject({
			url: `/bff/auth/github/callback?code=abc&state=${encodeURIComponent('state-12é')}`,
			headers: { cookie },
		})

		// Assert
		for (const response of [mismatch, missing, multibyte]) {
			expect(response.statusCode).toBe(302)
			expect(response.headers.location).toBe(`${portalCallback}?error=state`)
		}
		expect(app.githubOauth.fetchProfile).not.toHaveBeenCalled()
		expect(app.authService.signInWithGithub).not.toHaveBeenCalled()
	})

	it('Reports a denied authorization and a missing code back to the portal', async () => {
		// Act — the portal page forwards GitHub's own `?error=access_denied&state=` here
		const denied = await app.inject({
			url: `/bff/auth/github/callback?error=access_denied&state=${state}`,
			headers: { cookie },
		})
		const noCode = await app.inject({
			url: `/bff/auth/github/callback?state=${state}`,
			headers: { cookie },
		})

		// Assert
		expect(denied.headers.location).toBe(`${portalCallback}?error=denied`)
		expect(denied.headers['set-cookie']).toContain(`${stateCookieName}=; Max-Age=0`)
		expect(noCode.headers.location).toBe(`${portalCallback}?error=failed`)
		expect(app.githubOauth.fetchProfile).not.toHaveBeenCalled()
	})

	it('Reports an account without a verified email as an email error', async () => {
		// Arrange
		vi.spyOn(app.authService, 'signInWithGithub').mockRejectedValueOnce(
			new EntityInvalid('githubEmail', 'leela')
		)

		// Act
		const response = await app.inject({ url, headers: { cookie } })

		// Assert
		expect(response.statusCode).toBe(302)
		expect(response.headers.location).toBe(`${portalCallback}?error=email`)
		expect(app.authService.createLoginLink).not.toHaveBeenCalled()
	})

	it('Reports a failed code exchange as a generic failure', async () => {
		// Arrange
		vi.spyOn(app.githubOauth, 'fetchProfile').mockRejectedValueOnce(
			new Error('bad_verification_code')
		)

		// Act
		const response = await app.inject({ url, headers: { cookie } })

		// Assert
		expect(response.headers.location).toBe(`${portalCallback}?error=failed`)
		expect(app.authService.signInWithGithub).not.toHaveBeenCalled()
	})

	it('Answers 404 when no OAuth App is configured', async () => {
		// Arrange
		app = await createTestApp()
		Object.assign(app.githubOauth, unconfiguredClient)
		app.register(githubCallback)

		// Act
		const response = await app.inject({ url, headers: { cookie } })

		// Assert
		expect(response.statusCode).toBe(404)
	})
})

import { unconfiguredClient } from '#/plugins/githubOAuth.ts'
import github from '#/routes/bff/auth/github.ts'
import { readStateCookie, stateCookieName } from '#/routes/bff/auth/github.utils.ts'

import type { FastifyInstance } from 'fastify'

const url = '/bff/auth/github'

describe('GET /bff/auth/github route', () => {
	let app: FastifyInstance

	beforeEach(async () => {
		app = await createTestApp()
		app.register(github)
	})

	it('Redirects to GitHub with a random state kept in an httpOnly cookie', async () => {
		// Act
		const response = await app.inject({ url })

		// Assert
		expect(response.statusCode).toBe(302)
		const cookie = response.headers['set-cookie'] as string
		const state = readStateCookie(cookie.split(';')[0])!
		expect(state).toMatch(/^[A-Za-z0-9_-]{40,}$/)
		expect(cookie).toContain('HttpOnly')
		expect(cookie).toContain('SameSite=Lax')
		expect(cookie).toContain('Secure')
		expect(cookie).toContain('Path=/bff/auth/github')
		expect(response.headers.location).toContain(`state=${state}`)
		expect(app.githubOauth.authorizeUrl).toHaveBeenCalledWith({
			state,
			redirectUri: 'https://portal.example.com/auth/github/callback',
		})
	})

	it('Uses a fresh state on every request', async () => {
		// Act
		const first = await app.inject({ url })
		const second = await app.inject({ url })

		// Assert
		const stateOf = (cookie: string) => cookie.match(new RegExp(`${stateCookieName}=([^;]+)`))![1]
		expect(stateOf(first.headers['set-cookie'] as string)).not.toBe(
			stateOf(second.headers['set-cookie'] as string)
		)
	})

	it('Answers 404 when no OAuth App is configured', async () => {
		// Arrange
		app = await createTestApp()
		Object.assign(app.githubOauth, unconfiguredClient)
		app.register(github)

		// Act
		const response = await app.inject({ url })

		// Assert
		expect(response.statusCode).toBe(404)
		expect(response.headers['set-cookie']).toBeUndefined()
	})
})

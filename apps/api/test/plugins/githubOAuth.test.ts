import {
	githubApiUrl,
	githubAuthorizeUrl,
	githubTokenUrl,
	pickVerifiedEmail,
} from '#/plugins/githubOAuth.ts'

import type { FastifyInstance } from 'fastify'

const redirectUri = 'https://portal.example.com/auth/github/callback'

describe('GitHub OAuth plugin (githubOauth)', () => {
	let app: FastifyInstance

	beforeEach(async () => {
		app = await createTestApp({ skipMock: '#/plugins/githubOAuth.ts' })
	})

	it('Builds the authorize url with client id, redirect uri, scope and state', () => {
		// Act
		const url = new URL(app.githubOauth.authorizeUrl({ state: 's1', redirectUri }))

		// Assert
		expect(app.githubOauth.configured).toBe(true)
		expect(`${url.origin}${url.pathname}`).toBe(githubAuthorizeUrl)
		expect(Object.fromEntries(url.searchParams)).toEqual({
			client_id: 'gh-client-id',
			redirect_uri: redirectUri,
			scope: 'user:email',
			state: 's1',
		})
	})

	it('Exchanges the code and reads the profile with the primary verified email', async () => {
		// Arrange
		const token = networkMock
			.post(githubTokenUrl, {
				body: {
					client_id: 'gh-client-id',
					client_secret: 'gh-client-secret',
					code: 'abc',
					redirect_uri: redirectUri,
				},
			})
			.reply(200, { access_token: 'gho_token', token_type: 'bearer' })
		const user = networkMock
			.get(`${githubApiUrl}/user`, { headers: ['authorization'] })
			.reply(200, { id: 4242, login: 'leela', name: 'Turanga Leela' })
		networkMock.get(`${githubApiUrl}/user/emails`, { headers: ['authorization'] }).reply(200, [
			{ email: 'old@planetexpress.example', primary: false, verified: true },
			{ email: 'leela@planetexpress.example', primary: true, verified: true },
		])

		// Act
		const profile = await app.githubOauth.fetchProfile({ code: 'abc', redirectUri })

		// Assert
		expect(profile).toEqual({
			id: '4242',
			login: 'leela',
			name: 'Turanga Leela',
			email: 'leela@planetexpress.example',
		})
		expect(token.spy.called(1)).toBe(true)
		expect(user.spy.assert(req => req.headers.get('authorization') === 'Bearer gho_token')).toBe(
			true
		)
	})

	it('Fails the exchange when GitHub answers with an error instead of a token', async () => {
		// Arrange
		networkMock
			.post(githubTokenUrl)
			.reply(200, { error: 'bad_verification_code', error_description: 'The code is incorrect' })

		// Act + Assert
		await expect(app.githubOauth.fetchProfile({ code: 'stale', redirectUri })).rejects.toThrow(
			/exchange failed: The code is incorrect/
		)
	})

	it('Fails when the profile request is rejected', async () => {
		// Arrange
		networkMock.post(githubTokenUrl).reply(200, { access_token: 'gho_token' })
		networkMock.get(`${githubApiUrl}/user`).reply(401, { message: 'Bad credentials' })
		networkMock.get(`${githubApiUrl}/user/emails`).reply(200, [])

		// Act + Assert
		await expect(app.githubOauth.fetchProfile({ code: 'abc', redirectUri })).rejects.toThrow(
			/\/user failed: HTTP 401/
		)
	})

	it('Picks the primary verified email, falls back to any verified one, never an unverified one', () => {
		expect(
			pickVerifiedEmail([
				{ email: 'a@x.se', primary: true, verified: false },
				{ email: 'b@x.se', primary: false, verified: true },
			])
		).toBe('b@x.se')
		expect(pickVerifiedEmail([{ email: 'a@x.se', primary: true, verified: false }])).toBeUndefined()
		expect(pickVerifiedEmail([])).toBeUndefined()
	})

	it('Is unconfigured without an OAuth App', async () => {
		// Arrange
		vi.stubEnv('AUTH_AUDIENCE', 'audience')
		vi.stubEnv('GITHUB_OAUTH_CLIENT_ID', '')
		vi.stubEnv('ANTHROPIC_API_KEY', '')
		vi.stubEnv('ANTHROPIC_API_KEY_SECRET_ARN', '')
		vi.stubEnv('AUTH_JWT_PRIVATE_KEY_SECRET_ARN', '')
		vi.doUnmock('#/plugins/secrets.ts')
		vi.resetModules()
		const bare = await createTestApp({
			skipMock: ['#/plugins/githubOAuth.ts', '#/plugins/secrets.ts'],
		})

		// Assert
		expect(bare.secrets.githubOauth).toBeUndefined()
		expect(bare.githubOauth.configured).toBe(false)
		await expect(bare.githubOauth.fetchProfile({ code: 'abc', redirectUri })).rejects.toThrow(
			/not configured/
		)
		vi.unstubAllEnvs()
	})
})

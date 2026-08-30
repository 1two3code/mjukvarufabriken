import { z } from 'zod'

import { EntityNotFound } from '#/lib/entityError.ts'
import { buildStateCookie, githubRedirectUri } from '#/routes/bff/auth/github.utils.ts'
import { generateToken } from '#/services/authService.utils.ts'

import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	response: { 302: z.null() },
}

/**
 * Public route. Starts "Sign in with GitHub" (M6): remembers a random `state` in an httpOnly
 * cookie and sends the browser to GitHub's authorize page. 404 while no OAuth App is
 * configured (`GITHUB_OAUTH_CLIENT_ID`), so the portal can offer the button unconditionally.
 */
const route: FastifyPluginAsyncZod = async function (app) {
	const { githubOauth, secrets } = app
	const secure = secrets.portalUrl.startsWith('https:')

	app.get('/bff/auth/github', { schema }, async (_request, reply) => {
		if (!githubOauth.configured) return reply.error(404, new EntityNotFound('githubSignIn'))

		const state = generateToken()
		const url = githubOauth.authorizeUrl({
			state,
			redirectUri: githubRedirectUri(secrets.portalUrl),
		})
		return reply.header('set-cookie', buildStateCookie(state, secure)).redirect(url, 302)
	})
}

export default route

import { z } from 'zod'

import { EntityInvalid, EntityNotFound } from '#/lib/entityError.ts'
import {
	clearStateCookie,
	githubErrorRedirect,
	githubRedirectUri,
	isSameState,
	readStateCookie,
} from '#/routes/bff/auth/github.utils.ts'

import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import type { GithubSignInError } from '#/routes/bff/auth/github.utils.ts'

const schema = {
	querystring: z.object({
		code: z.string().min(1).optional(),
		state: z.string().min(1).optional(),
		/** GitHub's error code when the user denied access (`access_denied`) or the app is misconfigured */
		error: z.string().optional(),
	}),
	response: { 302: z.null() },
}

/**
 * Public route. Second half of "Sign in with GitHub": the portal's `/auth/github/callback`
 * page forwards GitHub's `code` + `state` here. Checks the state against the cookie, exchanges
 * the code, links/creates the user and redirects to the portal's magic-link callback with a
 * one-shot login token — the browser ends up with the same session/refresh tokens as after an
 * emailed link. Every failure redirects back to the portal page with an `error` code.
 */
const route: FastifyPluginAsyncZod = async function (app) {
	const { githubOauth, authService, secrets } = app
	const secure = secrets.portalUrl.startsWith('https:')

	/** Only a missing verified email gets its own message in the portal */
	const errorOf = (error: unknown): GithubSignInError =>
		error instanceof EntityInvalid && error.entityName === 'githubEmail' ? 'email' : 'failed'

	app.get('/bff/auth/github/callback', { schema }, async (request, reply) => {
		if (!githubOauth.configured) return reply.error(404, new EntityNotFound('githubSignIn'))

		const { query } = request
		reply.header('set-cookie', clearStateCookie(secure))
		const fail = (error: GithubSignInError) =>
			reply.redirect(githubErrorRedirect(secrets.portalUrl, error), 302)

		if (query.error || !query.code || !query.state) {
			request.log.info({ error: query.error }, 'GitHub sign-in rejected')
			return fail(query.error === 'access_denied' ? 'denied' : 'failed')
		}
		if (!isSameState(readStateCookie(request.headers.cookie), query.state)) {
			request.log.warn('GitHub sign-in state mismatch')
			return fail('state')
		}

		try {
			const profile = await githubOauth.fetchProfile({
				code: query.code,
				redirectUri: githubRedirectUri(secrets.portalUrl),
			})
			const user = await authService.signInWithGithub(profile)
			return reply.redirect(await authService.createLoginLink(user), 302)
		} catch (error) {
			request.log.error({ err: error }, 'GitHub sign-in failed')
			return fail(errorOf(error))
		}
	})
}

export default route

import { SignJWT } from 'jose'
import { JobPreviewTokenResponseSchema } from '@mf/models'
import { tryCatch } from '@mf/utils/function'

import { authAlgorithm } from '#/plugins/authKeys.utils.ts'
import { authenticateJobReport, jobParams } from '#/routes/internal/jobs/jobToken.utils.ts'

import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	params: jobParams,
	response: { 200: JobPreviewTokenResponseSchema },
}

/** Long enough for one live acceptance run, short enough to be worthless if it leaks */
export const previewTokenTtl = '10m'

/**
 * Mints a short-lived access token for the job's DELIVERED preview app (Gate C): the post-deploy
 * acceptance check probes auth-gated routes with it, so a 401-only surface is actually exercised
 * instead of guessed at. Signed with the api's own key (the delivered app verifies against our
 * JWKS — the previewAuth contract delivery already injects), but with the PREVIEW audience:
 * minting is refused outright when that audience equals the api's own, because such a token
 * would be valid against this api itself — a per-job report token must never escalate.
 */
const route: FastifyPluginAsyncZod = async function (app) {
	const { authKeys, secrets } = app

	app.post('/internal/jobs/:jobId/preview-token', { schema }, async (request, reply) => {
		const job = await authenticateJobReport(app, request, reply, request.params.jobId)
		if (!job) return
		if (secrets.preview.tokenAudience === secrets.authAudience) {
			return reply.error(
				503,
				'PREVIEW_TOKEN_AUDIENCE equals AUTH_AUDIENCE — refusing to mint a preview token that would be valid against this api'
			)
		}
		const [error, token] = await tryCatch(
			new SignJWT({ name: 'Live acceptance check', role: 'admin' })
				.setProtectedHeader({ alg: authAlgorithm, kid: authKeys.kid })
				.setSubject(`preview-check:${job.id}`)
				.setIssuer(secrets.authIssuer)
				.setAudience(secrets.preview.tokenAudience)
				.setIssuedAt()
				.setExpirationTime(previewTokenTtl)
				.sign(authKeys.privateKey)
		)
		if (error) return reply.error(500, error)
		return reply.send({ token })
	})
}

export default route

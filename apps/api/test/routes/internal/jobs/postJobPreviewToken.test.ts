import { jwtVerify } from 'jose'

import { EntityNotFound } from '#/lib/entityError.ts'
import { getMockAuthKeys } from '#/plugins/__mocks__/authKeys.ts'
import postJobPreviewToken from '#/routes/internal/jobs/postJobPreviewToken.ts'
import { ReportUnauthorized } from '#/services/jobService.ts'

import type { FastifyInstance } from 'fastify'

describe('POST /internal/jobs/:jobId/preview-token route', () => {
	let app: FastifyInstance

	const url = '/internal/jobs/job-1/preview-token'
	const headers = { authorization: 'Bearer job-token' }

	beforeEach(async () => {
		app = await createTestApp()
		app.register(postJobPreviewToken)
	})

	it('Mints a short-lived token for the PREVIEW audience, never the api audience', async () => {
		// Arrange
		// Act
		const response = await app.inject({ method: 'POST', url, headers })

		// Assert
		expect(response.statusCode).toBe(200)
		const { token } = response.json<{ token: string }>()
		const { payload } = await jwtVerify(token, getMockAuthKeys().publicKey, {
			issuer: app.secrets.authIssuer,
			audience: 'preview',
		})
		expect(payload.sub).toBe('preview-check:job-1')
		expect(payload.role).toBe('admin')
		// Not valid for the api's own audience — the per-job token must never escalate
		await expect(
			jwtVerify(token, getMockAuthKeys().publicKey, { audience: app.secrets.authAudience })
		).rejects.toThrow()
	})

	it('Refuses to mint when the preview audience equals the api audience', async () => {
		// Arrange
		app.secrets.preview.tokenAudience = app.secrets.authAudience

		// Act
		const response = await app.inject({ method: 'POST', url, headers })

		// Assert
		expect(response.statusCode).toBe(503)
	})

	it('Responds 401 to a wrong token', async () => {
		// Arrange
		vi.spyOn(app.jobService, 'authenticateReport').mockRejectedValue(new ReportUnauthorized())

		// Act
		const response = await app.inject({ method: 'POST', url, headers })

		// Assert
		expect(response.statusCode).toBe(401)
	})

	it("Responds 404 to another job's token", async () => {
		// Arrange
		vi.spyOn(app.jobService, 'authenticateReport').mockRejectedValue(
			new EntityNotFound('job', 'job-1')
		)

		// Act
		const response = await app.inject({ method: 'POST', url, headers })

		// Assert
		expect(response.statusCode).toBe(404)
	})
})

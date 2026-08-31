import { EntityNotFound } from '#/lib/entityError.ts'
import postJobDatabase from '#/routes/internal/jobs/postJobDatabase.ts'
import { ReportUnauthorized } from '#/services/jobService.ts'
import { mockPreviewDatabaseUrl } from '#/services/__mocks__/previewDbService.ts'
import { ProvisioningUnavailable } from '#/services/previewDbService.ts'

import type { FastifyInstance } from 'fastify'

describe('POST /internal/jobs/:jobId/database route', () => {
	let app: FastifyInstance

	const url = '/internal/jobs/job-1/database'
	const headers = { authorization: 'Bearer job-token' }

	beforeEach(async () => {
		app = await createTestApp()
		app.register(postJobDatabase)
	})

	it('Provisions the job database and returns ONLY the scoped connection string', async () => {
		// Arrange
		// Act
		const response = await app.inject({ method: 'POST', url, headers })

		// Assert
		expect(app.jobService.authenticateReport).toHaveBeenCalledWith('job-1', 'job-token')
		expect(app.previewDbService.provision).toHaveBeenCalledWith('job-1')
		expect(response.statusCode).toBe(200)
		expect(response.json()).toEqual({ databaseUrl: mockPreviewDatabaseUrl })
	})

	it('Responds 401 to a wrong token — no provisioning happens', async () => {
		// Arrange
		vi.spyOn(app.jobService, 'authenticateReport').mockRejectedValue(new ReportUnauthorized())

		// Act
		const response = await app.inject({ method: 'POST', url, headers })

		// Assert
		expect(response.statusCode).toBe(401)
		expect(app.previewDbService.provision).not.toHaveBeenCalled()
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

	it('Responds 503 when no admin database is configured (the job fails its deploy closed)', async () => {
		// Arrange
		vi.spyOn(app.previewDbService, 'provision').mockRejectedValue(
			new ProvisioningUnavailable('no admin database configured')
		)

		// Act
		const response = await app.inject({ method: 'POST', url, headers })

		// Assert
		expect(response.statusCode).toBe(503)
	})
})

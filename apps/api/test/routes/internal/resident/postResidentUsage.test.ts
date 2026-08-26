import { residentUsageRecordIssues } from '@mf/models'

import postResidentUsage from '#/routes/internal/resident/postResidentUsage.ts'
import { createMockResidentUsageRecord } from '#/services/__mocks__/residentService.ts'
import { ResidentUnauthorized } from '#/services/residentService.ts'

import type { FastifyInstance } from 'fastify'

describe('POST /internal/resident/usage route', () => {
	let app: FastifyInstance

	const url = '/internal/resident/usage'
	const headers = { authorization: 'Bearer installation-token' }
	const record = createMockResidentUsageRecord()

	beforeEach(async () => {
		app = await createTestApp()
		app.register(postResidentUsage)
	})

	it('Stores the record of the authenticated installation', async () => {
		// Arrange
		// Act
		const response = await app.inject({ method: 'POST', url, headers, payload: record })

		// Assert
		expect(app.residentService.authenticate).toHaveBeenCalledWith('installation-token')
		expect(app.residentService.recordUsage).toHaveBeenCalledWith(record)
		expect(response.statusCode).toBe(200)
		expect(response.json()).toEqual({ id: 'acme-shop/2026-09-03', stored: true })
	})

	it("Refuses a record for another installation's id with 403", async () => {
		// Arrange
		const other = createMockResidentUsageRecord({ installationId: 'someone-else' })

		// Act
		const response = await app.inject({ method: 'POST', url, headers, payload: other })

		// Assert
		expect(response.statusCode).toBe(403)
		expect(app.residentService.recordUsage).not.toHaveBeenCalled()
	})

	it('Responds 401 to an unknown token and 400 to a malformed record', async () => {
		// Arrange
		vi.spyOn(app.residentService, 'authenticate').mockRejectedValueOnce(new ResidentUnauthorized())

		// Act
		const unauthorized = await app.inject({ method: 'POST', url, headers, payload: record })
		const malformed = await app.inject({
			method: 'POST',
			url,
			headers,
			payload: { ...record, cost: { listPriceUsd: -1 } },
		})

		// Assert
		expect(unauthorized.statusCode).toBe(401)
		expect(malformed.statusCode).toBe(400)
		expect(app.residentService.recordUsage).not.toHaveBeenCalled()
	})

	it("Rejects a record whose billable amount, markup or month is not the day's own", async () => {
		// The resident runs in the customer's account: the figures it cannot choose are checked
		const post = (payload: object) => app.inject({ method: 'POST', url, headers, payload })

		const underbilled = await post(
			createMockResidentUsageRecord({ cost: { listPriceUsd: 4.5, markup: 1.5, billableUsd: 0 } })
		)
		const ownMarkup = await post(
			createMockResidentUsageRecord({ cost: { listPriceUsd: 4.5, markup: 1, billableUsd: 4.5 } })
		)
		const otherMonth = await post(createMockResidentUsageRecord({ month: '2099-01' }))
		const ok = await post(
			createMockResidentUsageRecord({ cost: { listPriceUsd: 4.5, markup: 1.5, billableUsd: 6.75 } })
		)

		expect(underbilled.statusCode).toBe(400)
		expect(ownMarkup.statusCode).toBe(400)
		expect(otherMonth.statusCode).toBe(400)
		expect(residentUsageRecordIssues(createMockResidentUsageRecord({ month: '2099-01' }))).toEqual([
			"month 2099-01 is not the day's",
		])
		expect(ok.statusCode).toBe(200)
		expect(app.residentService.recordUsage).toHaveBeenCalledTimes(1)
	})
})

import { createMockResidentUsageRecord } from '#/services/__mocks__/residentService.ts'
import { installationOf, ResidentUnauthorized } from '#/services/residentService.ts'

import type { FastifyInstance } from 'fastify'

describe('Resident Service', () => {
	let app: FastifyInstance

	beforeEach(async () => {
		app = await createTestApp({ skipMock: '#/services/residentService.ts' })
		app.secrets.residentInstallations = { 'acme-shop': 'token-a', 'beta-crm': 'token-b' }
	})

	it('Resolves an installation token and rejects unknown ones', async () => {
		expect(await app.residentService.authenticate('token-b')).toBe('beta-crm')
		await expect(app.residentService.authenticate('nope')).rejects.toThrow(ResidentUnauthorized)
		await expect(app.residentService.authenticate(undefined)).rejects.toThrow(ResidentUnauthorized)
		expect(installationOf({}, 'token-a')).toBeUndefined()
	})

	it('Stores one record per installation and day, last write wins, newest first', async () => {
		// Arrange
		const monday = createMockResidentUsageRecord({ day: '2026-09-07' })
		const tuesday = createMockResidentUsageRecord({ day: '2026-09-08', totalTokens: 10 })
		const tuesdayAgain = createMockResidentUsageRecord({ day: '2026-09-08', totalTokens: 20 })
		const other = createMockResidentUsageRecord({ installationId: 'beta-crm', day: '2026-09-09' })

		// Act
		expect(await app.residentService.recordUsage(monday)).toEqual({
			id: 'acme-shop/2026-09-07',
			stored: true,
		})
		await app.residentService.recordUsage(tuesday)
		await app.residentService.recordUsage(tuesdayAgain)
		await app.residentService.recordUsage(other)

		// Assert
		const acme = await app.residentService.listUsage('acme-shop')
		expect(acme.map(record => [record.day, record.totalTokens])).toEqual([
			['2026-09-08', 20],
			['2026-09-07', 1_100_000],
		])
		expect(await app.residentService.listUsage()).toHaveLength(3)
	})
})
